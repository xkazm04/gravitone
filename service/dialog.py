"""Who the agent is, and what it says next.

Two things live here, both deliberately kept out of service/convai.py so that
the protocol file is only ever about the protocol:

* **The agent registry.** An agent is the ElevenLabs unit of configuration —
  a prompt, a voice, a language, an opening line — and this service stores one
  as a JSON file next to voices/ and takes/. ``BUILTIN_AGENTS`` ships a working
  interviewer, so an empty directory is a complete installation.

* **The brain.** ``ScriptedBackend`` and ``OpenAiCompatBackend`` both answer
  one question — given the conversation so far, what does the agent say? — and
  both answer it as a stream of SENTENCES rather than one blob. That shape is
  the latency win: the session can start synthesizing sentence one while the
  model is still writing sentence two, so time-to-first-audio stops scaling
  with reply length.

* **The directing channel.** A brain answers with ``TurnPart``s, not bare
  strings: a part carries its text AND how the text should be performed —
  which language to speak it in, which emotion, and whether the call ends
  after it. The parts are ``str`` subclasses, so every consumer written
  against the old "stream of sentences" contract keeps working untouched;
  the direction is metadata riding along beside the words. Models express it
  inline (``[lang:cs]``, ``[emotion:warm]``, ``[end_call]``) and the sentence
  buffer strips it before the text can reach a synthesizer or a transcript.

The scripted backend is the default and is not a placeholder. A test that
asserts word error rate, turn latency or transcript structure needs the
interviewer to say the same thing every run; an LLM makes all three
non-deterministic. Realism is the other mode, one env var away.

Prompt overrides arrive from the CLIENT (``conversation_config_override``),
which is ElevenLabs' trust model, not one this service invented: the browser
SDK sends the per-session prompt, so any caller on that socket can rewrite the
agent's instructions. ``Agent.allow_overrides`` is the per-agent switch, and an
agent that must not be re-prompted sets it to an empty list.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import AsyncIterator

from service.config import SETTINGS

logger = logging.getLogger("gravitone.dialog")

# Same boundary the streaming synthesis route splits on (app._SENTENCE_SPLIT_RE)
# — one idea of where a sentence ends, however the text was produced.
_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")
# A model that writes a long clause with no terminal punctuation would otherwise
# never flush a sentence, and the whole latency argument above quietly stops
# applying. Past this many characters the buffer is emitted at the last comma or
# space instead of waiting for a full stop that may never come.
_FORCE_FLUSH_CHARS = 220


class DialogError(RuntimeError):
    """The brain could not answer. Authored for an operator: the session closes
    the socket with this text, so it has to say what actually broke."""


@dataclass(frozen=True)
class Agent:
    agent_id: str
    name: str
    prompt: str
    first_message: str = ""
    voice_id: str = ""            # empty = the service's default voice
    language: str = "en"
    temperature: float = 0.4
    # Words the transcriber should be biased toward while this agent is
    # listening. The local answer to the ASR corruption a cloud agent needed a
    # dashboard keyword list to survive — and here it is per session.
    keywords: list[str] = field(default_factory=list)
    # Fixed interviewer turns for the scripted backend, in order.
    script: list[str] = field(default_factory=list)
    # What to call the person on the other end when the conversation is
    # rendered for a language model. "Candidate" is right for an interviewer and
    # wrong for everything else — including an agent that IS the candidate,
    # which is exactly what a two-sided simulation needs.
    counterpart: str = "Candidate"
    # Which conversation_config_override fields a client may set.
    allow_overrides: list[str] = field(
        default_factory=lambda: ["prompt", "first_message", "language", "voice_id",
                                 "script"])
    # Languages this agent will FOLLOW the caller into, beyond its own. Declared
    # rather than inferred: the ear hears dozens of languages, but an agent
    # switching into one nobody checked a voice for is a worse conversation than
    # one that stays put. Appended LAST so no positional construction breaks.
    languages: list[str] = field(default_factory=list)

    def voice(self) -> str:
        return self.voice_id or SETTINGS.default_voice

    def switch_languages(self) -> list[str]:
        """Every language this agent may speak, its own first.

        Deduplicated and region-stripped ("cs-CZ" -> "cs") because that is the
        form both the transcriber's detection and ``piper.voice_for_language``
        speak. This list is what ``/v1/convai/agents`` reports as a matrix and
        what the language tracker is allowed to switch into.
        """
        out = [_tag(self.language) or "en"]
        for lang in self.languages:
            tag = _tag(lang)
            if tag and tag not in out:
                out.append(tag)
        return out

    def honours(self, language: str | None) -> bool:
        """Whether a switch into ``language`` is one this agent agreed to."""
        tag = _tag(language)
        return bool(tag) and tag in self.switch_languages()


def language_tag(language: str | None) -> str:
    """"cs-CZ" -> "cs". ONE idea of what a language is.

    Public because the session layer has to agree with this module about it: the
    transcriber reports "cs", an agent file may say "cs-CZ", and a Piper voice is
    called "cs_CZ-jirka-medium". Comparing any two of those without normalizing
    is how a language switch silently never fires.
    """
    return (language or "").strip().split("-", 1)[0].lower()


_tag = language_tag   # the short name this module reads better with


_INTERVIEWER_PROMPT = (
    "You are a professional job interviewer conducting a spoken screening "
    "interview. Ask ONE question at a time and keep every turn to two sentences "
    "or fewer — this is a voice conversation, and long turns are unlistenable. "
    "Acknowledge what the candidate just said before moving on. Do not answer "
    "your own questions, and do not read out lists."
)

# Shipped so the module works with an empty agents directory. The script is a
# real screening arc (open, background, depth, example, close) rather than
# filler: it is what the automated conversation tests actually run against.
BUILTIN_AGENTS: dict[str, Agent] = {
    "local-interviewer": Agent(
        agent_id="local-interviewer",
        name="Local interviewer",
        prompt=_INTERVIEWER_PROMPT,
        # The opening DISCLOSES that the interviewer is an AI and that the
        # conversation is transcribed. That is not decoration: applications
        # embedding a voice interviewer check for it (kp's interview harness
        # fails a run whose opening omits it), several jurisdictions require
        # telling a candidate they are being screened by an automated system,
        # and the person on the other end deserves to know before they answer.
        first_message="Hello, and thanks for making the time. Before we start — "
                      "I'm an AI interviewer, and this conversation is being "
                      "transcribed. To begin, could you tell me a little about "
                      "your background?",
        language="en",
        # Bias the transcriber toward the nouns a technical interview is made of.
        # This is not decoration: without it "PostgreSQL" comes back as
        # "pozdějc Esquale" and "React" as "Rust" — the same corruption a hosted
        # agent needed a dashboard keyword list to survive, except here it is
        # per session and an agent file can extend it per role.
        keywords=["PostgreSQL", "Python", "JavaScript", "TypeScript", "React",
                  "Kubernetes", "Docker", "Terraform", "Kafka", "Redis",
                  "GraphQL", "API", "backend", "frontend", "DevOps", "CI/CD"],
        script=[
            "Thanks, that's helpful. What does your day to day work look like right now?",
            "Interesting. Which part of that do you find most difficult?",
            "Could you walk me through a specific project you're proud of?",
            "What would you want to be doing more of in your next role?",
            "That's everything I wanted to cover. Thanks for your time today, "
            "we'll be in touch soon.",
        ],
    ),
    # The same interviewer in Czech — the case that proves the second engine is
    # real. It names NO voice: `language: "cs"` is enough, because Pocket TTS
    # cannot speak Czech and the session resolves a Piper voice for it
    # (convai._resolve_voice). With no Czech voice installed this agent reports
    # itself unspeakable instead of reading Czech with English phonemes.
    "local-interviewer-cs": Agent(
        agent_id="local-interviewer-cs",
        name="Local interviewer (Czech)",
        prompt="Jsi profesionální personalista a vedeš telefonický screeningový "
               "pohovor. Pokládej vždy JEDNU otázku a odpověz nejvýše dvěma "
               "větami — je to hlasový rozhovor. Mluv česky.",
        first_message="Dobrý den a děkuji, že jste si našel čas. Než začneme — "
                      "jsem umělá inteligence a tento rozhovor se přepisuje. "
                      "Můžete mi na úvod říct něco o své praxi?",
        language="cs",
        # Czech needs this MORE than English does: a Czech-language transcriber
        # has no reason to expect English product names, so "backendové" became
        # "bekendové" and "PostgreSQL" became "pozdějc Esquale" without it.
        keywords=["PostgreSQL", "Python", "JavaScript", "TypeScript", "React",
                  "Kubernetes", "Docker", "backendové", "frontend", "API",
                  "Kafka", "Redis", "DevOps"],
        script=[
            "Děkuji. Jak vypadá vaše současná práce?",
            "Zajímavé. Co je na tom pro vás nejnáročnější?",
            "Můžete mi popsat konkrétní projekt, na který jste hrdý?",
            "Čemu byste se chtěl věnovat více?",
            "To je vše, co jsem potřeboval. Děkuji za váš čas, ozveme se.",
        ],
    ),
}


def agents_dir() -> Path:
    return Path(SETTINGS.convai_agents_dir)


def _from_file(path: Path) -> Agent | None:
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        # A malformed agent file is an operator error, not a caller error: it is
        # logged and skipped so ONE bad file cannot take the whole registry down.
        logger.error("ignoring agent file %s: %s", path.name, exc)
        return None
    known = {f for f in Agent.__dataclass_fields__}
    fields = {k: v for k, v in data.items() if k in known}
    fields["agent_id"] = data.get("agent_id") or path.stem
    fields.setdefault("name", fields["agent_id"])
    if not fields.get("prompt"):
        logger.error("ignoring agent file %s: no prompt", path.name)
        return None
    try:
        return Agent(**fields)
    except TypeError as exc:
        logger.error("ignoring agent file %s: %s", path.name, exc)
        return None


def list_agents() -> list[Agent]:
    """Every agent this replica can run: the built-ins plus the directory.

    A file whose id collides with a built-in WINS — that is how an operator
    re-voices or re-prompts the shipped interviewer without editing the source.
    """
    found = dict(BUILTIN_AGENTS)
    d = agents_dir()
    if d.is_dir():
        for path in sorted(d.glob("*.json")):
            agent = _from_file(path)
            if agent is not None:
                found[agent.agent_id] = agent
    return list(found.values())


def get_agent(agent_id: str) -> Agent | None:
    if not agent_id:
        return None
    return next((a for a in list_agents() if a.agent_id == agent_id), None)


def apply_overrides(agent: Agent, override: dict | None) -> Agent:
    """Fold a client's ``conversation_config_override.agent`` into the agent.

    Only fields the agent permits are applied; the rest are dropped and named in
    the log, because a silently-ignored override looks exactly like an override
    that worked until someone plays back the audio.
    """
    if not override:
        return agent
    allowed = set(agent.allow_overrides)
    changes: dict = {}
    refused: list[str] = []

    prompt = (override.get("prompt") or {}).get("prompt")
    if prompt:
        (changes.__setitem__("prompt", str(prompt)) if "prompt" in allowed
         else refused.append("prompt"))
    first = override.get("first_message")
    if first is not None:
        (changes.__setitem__("first_message", str(first))
         if "first_message" in allowed else refused.append("first_message"))
    script = override.get("script")
    if script is not None:
        # A client-supplied script, which is what lets a browser rehearse a scene
        # with NO language model configured: the lines come from the page and the
        # scripted backend reads them back, so the whole Live path works on a box
        # with no LLM at all. Same trust model as ``prompt`` (see the module
        # docstring) — an agent that must keep its own words drops "script" from
        # allow_overrides. Each line may carry the inline directives a script line
        # always could ("[lang:cs] Ahoj."), because it goes through the same buffer.
        if not isinstance(script, list):
            logger.warning("agent %s ignored a non-list script override (%s)",
                           agent.agent_id, type(script).__name__)
        elif "script" not in allowed:
            refused.append("script")
        else:
            changes["script"] = [str(line) for line in script if str(line).strip()]
    lang = override.get("language")
    if lang:
        (changes.__setitem__("language", str(lang)) if "language" in allowed
         else refused.append("language"))
    voice = (override.get("tts") or {}).get("voice_id")
    if voice:
        (changes.__setitem__("voice_id", str(voice)) if "voice_id" in allowed
         else refused.append("voice_id"))

    if refused:
        logger.warning("agent %s refused overrides %s (allow_overrides=%s)",
                       agent.agent_id, refused, agent.allow_overrides)
    return replace(agent, **changes) if changes else agent


# ---------------------------------------------------------------------------
# Sentence streaming
# ---------------------------------------------------------------------------
@dataclass(frozen=True, eq=False, repr=False)
class TurnPart(str):
    """One speakable unit of a turn, and how it is to be performed.

    ``language``/``emotion`` of ``None`` mean "the agent's own", so a brain that
    directs nothing produces parts indistinguishable from the plain sentences
    this used to emit — which is the point.

    **It IS a string.** Subclassing ``str`` is the compatibility shim: the whole
    pipeline downstream of a brain (``" ".join(parts)``, ``text.strip()``,
    ``synthesize_pcm(voice, part)``, every existing test that compares a reply to
    a list of strings) was written against a stream of sentences and keeps
    working with no change at all. Equality and hashing are the string's, on
    purpose: a part IS its speakable text, and the direction is metadata beside
    it. Two parts with the same words and different languages therefore compare
    equal — read ``.language`` when that distinction is what you mean.
    """

    text: str = ""
    language: str | None = None
    emotion: str | None = None
    end_call: bool = False

    def __new__(cls, text: str = "", *_args, **_kwargs):
        return super().__new__(cls, text)

    def __repr__(self) -> str:
        extra = "".join(
            f" {name}={value!r}" for name, value in
            (("language", self.language), ("emotion", self.emotion))
            if value is not None)
        return (f"TurnPart({str.__repr__(str(self))}{extra}"
                f"{' end_call' if self.end_call else ''})")

    def directed(self) -> bool:
        """Whether the brain asked for anything beyond the default performance."""
        return bool(self.language or self.emotion or self.end_call)

    def speakable(self) -> bool:
        """Whether there are words here at all.

        A part with no text is a PURE DIRECTION — the shape ``[end_call]`` takes
        when it is written after the last sentence, which is where a model
        naturally puts it. A consumer must honour its fields and synthesize
        nothing; see ``_SentenceBuffer.drain``.
        """
        return bool(str(self).strip())


# The inline grammar a model uses to direct its own turn. Deliberately bracketed
# and single-token: it is cheap for a model to emit, trivial to strip with
# certainty, and impossible to confuse with prose punctuation.
_BRACKET = re.compile(r"\[([^\[\]]*)\]")
_DIRECTIVES = {"lang": "language", "language": "language",
               "emotion": "emotion", "style": "emotion",
               "end_call": "end_call", "endcall": "end_call", "hangup": "end_call"}
# How much unterminated "[..." the buffer will hold back waiting for the closing
# bracket. Bounded because a model that writes a lone "[" and never closes it
# must not stall the turn forever; past this the bracket is ordinary text.
_DIRECTIVE_HOLD_CHARS = 48


def split_sentences(text: str) -> list[TurnPart]:
    """A finished piece of text as speakable parts, directives stripped.

    Runs the same buffer the streaming brains use, so an agent's
    ``first_message`` cannot smuggle directive text into the synthesizer either.
    """
    buf = _SentenceBuffer()
    return buf.push(text or "") + buf.drain()


class _SentenceBuffer:
    """Turns a stream of model deltas into a stream of speakable ``TurnPart``s.

    Two jobs, in this order: strip the direction out of the stream, and cut what
    is left at sentence boundaries. The order matters — the stripping happens on
    the RAW tail before anything is considered speakable, so no partially
    received directive can ever be emitted, however the deltas were chunked.
    """

    def __init__(self) -> None:
        self._buf = ""      # cleaned text, waiting for a boundary
        self._raw = ""      # the tail, which may still hold a partial directive
        self._language: str | None = None
        self._emotion: str | None = None
        self._end_call = False
        self._end_call_sent = False

    def push(self, delta: str) -> list[TurnPart]:
        self._raw += delta
        out: list[TurnPart] = []
        while self._raw:
            start = self._raw.find("[")
            if start < 0:
                self._buf += self._raw
                self._raw = ""
                break
            if start:
                self._buf += self._raw[:start]
                self._raw = self._raw[start:]
            match = _BRACKET.match(self._raw)
            if match is None:
                if len(self._raw) <= _DIRECTIVE_HOLD_CHARS:
                    break  # a directive may still be arriving: hold it back
                # Not a directive at all — an unclosed bracket in ordinary
                # prose. Speak it rather than swallow the rest of the turn.
                self._buf += self._raw[0]
                self._raw = self._raw[1:]
                continue
            out += self._direct(match.group(1))
            self._raw = self._raw[match.end():]
        return out + self._cut()

    def _direct(self, body: str) -> list[TurnPart]:
        """Apply one directive, returning any part it closed off."""
        name, _, value = body.partition(":")
        key = _DIRECTIVES.get(name.strip().lower())
        value = value.strip()
        if key is None or (key != "end_call" and not value):
            # Dropped and NAMED. A model that invents a directive (or writes
            # "[laughs]") must not have it read out loud, and an operator has to
            # be able to see that it happened.
            logger.warning("dropped an unknown dialog directive [%s]; it was not "
                           "spoken", body[:40].replace("\n", " "))
            return []
        if key == "end_call":
            # Latched rather than a boundary, so it rides out with whatever words
            # follow it. A model normally writes it AFTER its last sentence
            # ("Thanks for your time. [end_call]"), by which point that sentence
            # has already been released for synthesis — holding sentences back on
            # the chance a directive follows would give away the whole streaming
            # latency win. So when there is nothing left to attach it to,
            # ``drain`` emits it as a pure direction; see there.
            self._end_call = True
            return []
        # A change of language or emotion IS a boundary: whatever is already
        # buffered was written to be performed the old way, and switching the
        # mouth mid-sentence is the audible discontinuity this whole feature
        # exists to avoid.
        closed = self._cut(force=True)
        if key == "language":
            self._language = _tag(value)
        else:
            self._emotion = value.lower()
        return closed

    def _cut(self, *, force: bool = False) -> list[TurnPart]:
        out: list[TurnPart] = []
        while True:
            match = _SENTENCE_END.search(self._buf)
            if match:
                out.append(self._part(self._buf[:match.start()]))
                self._buf = self._buf[match.end():]
                continue
            if len(self._buf) >= _FORCE_FLUSH_CHARS:
                # Break within the flush WINDOW, not at the last separator in
                # the buffer — the latter emits everything received so far and
                # gives back exactly the long chunk this exists to avoid. A
                # comma is kept with the clause it closes; it is a breath.
                head = self._buf[:_FORCE_FLUSH_CHARS]
                comma = head.rfind(", ")
                cut = comma + 1 if comma > 0 else head.rfind(" ")
                if cut <= 0:
                    break  # one unbroken 220-character word: leave it to drain
                out.append(self._part(self._buf[:cut]))
                self._buf = self._buf[cut:].lstrip()
                continue
            break
        if force and self._buf.strip():
            out.append(self._part(self._buf))
            self._buf = ""
        return [p for p in out if p]

    def _part(self, text: str) -> TurnPart:
        text = text.strip()
        if text and self._end_call:
            self._end_call_sent = True
        return TurnPart(text, language=self._language, emotion=self._emotion,
                        end_call=self._end_call)

    def pending(self) -> bool:
        return bool(self._buf.strip() or self._raw.strip())

    def drain(self) -> list[TurnPart]:
        out = self.push("")   # consume anything the tail can still resolve to
        if self._raw.strip():
            # A directive that was cut off when the stream ended. Dropped, not
            # spoken: half of "[lang:c" is not text anybody wrote to be heard.
            logger.warning("dropped a truncated dialog directive %r at the end of "
                           "a turn", self._raw[:40])
        self._raw = ""
        rest, self._buf = self._buf.strip(), ""
        if rest:
            out.append(self._part(rest))
        out = [p for p in out if p]
        if self._end_call and not self._end_call_sent:
            # "[end_call]" written after the last sentence. It has no words of its
            # own, so it goes out as a pure direction rather than being lost — the
            # session hangs up on it, and a consumer that only wants text skips it
            # with ``TurnPart.speakable()``.
            self._end_call_sent = True
            out.append(TurnPart("", language=self._language,
                                emotion=self._emotion, end_call=True))
        return out


# ---------------------------------------------------------------------------
# Directing: what the brain is told, and what it is allowed to change mid-call
# ---------------------------------------------------------------------------
# Language names in the grammatical form each language's apology needs: nouns in
# English and French ("I can't speak German"), adverbs in Czech ("nemluvim
# nemecky"). Small on purpose — a tag is a usable fallback, a mistranslation is
# not, so an unlisted language is named by its code rather than guessed at.
_LANGUAGE_NAMES: dict[str, dict[str, str]] = {
    "en": {"en": "English", "fr": "French", "cs": "Czech", "de": "German",
           "es": "Spanish", "it": "Italian", "pl": "Polish", "sk": "Slovak",
           "pt": "Portuguese", "nl": "Dutch", "uk": "Ukrainian", "ru": "Russian"},
    "fr": {"en": "anglais", "fr": "français", "cs": "tchèque", "de": "allemand",
           "es": "espagnol", "it": "italien", "pl": "polonais", "sk": "slovaque"},
    "cs": {"en": "anglicky", "fr": "francouzsky", "cs": "česky", "de": "německy",
           "es": "španělsky", "it": "italsky", "pl": "polsky", "sk": "slovensky"},
}

# The authored refusal for a switch this replica cannot make, in the language it
# CAN still speak. The point of the whole feature is not reading one language
# with another's phonemes, and that applies to the apology most of all.
_SWITCH_APOLOGY = {
    "en": "I'm sorry — I can't speak {wanted} on this line, so I'll carry on in "
          "English.",
    "fr": "Je suis désolé, je ne parle pas {wanted} sur cette ligne ; je continue "
          "en français.",
    "cs": "Omlouvám se, {wanted} tady neumím. Budu pokračovat česky.",
}

_DIRECTIVE_BRIEF = (
    "You may direct your own delivery with inline tags. They are removed before "
    "anything is spoken, so never read one out loud and never mention them: "
    "[lang:XX] changes the language of the words that follow, [emotion:NAME] "
    "changes the tone, and [end_call] on your final turn ends the call.")


def language_name(speak_language: str, wanted_language: str | None) -> str:
    """``wanted_language`` as a speaker of ``speak_language`` would name it."""
    speak, wanted = _tag(speak_language) or "en", _tag(wanted_language)
    names = _LANGUAGE_NAMES.get(speak, _LANGUAGE_NAMES["en"])
    return names.get(wanted, wanted or "")


def switch_apology(speak_language: str, wanted_language: str | None) -> str:
    """"The caller switched to a language we have no mouth for" — said out loud.

    Spoken in ``speak_language``, which is the whole point: an English apology
    read by a Czech voice is the mispronunciation this refuses to produce.
    """
    speak = _tag(speak_language) or "en"
    template = _SWITCH_APOLOGY.get(speak, _SWITCH_APOLOGY["en"])
    wanted = language_name(speak, wanted_language) or _tag(wanted_language)
    return template.format(wanted=wanted or "that language")


def directing_prompt(agent: Agent, *, speaking: str | None = None,
                     heard: str | None = None) -> str:
    """The agent's brief, plus what it may direct on THIS call.

    Kept out of ``Agent.prompt`` so the stored agent stays the operator's text:
    this is assembled per turn from what the session currently knows (which
    language is being spoken, which one the ear just heard), and an agent that
    declared no extra languages is told to stay put rather than being handed a
    switching instruction it has no voice for.
    """
    speaking = _tag(speaking) or _tag(agent.language) or "en"
    extra = [lang for lang in agent.switch_languages() if lang != speaking]
    clauses = [_DIRECTIVE_BRIEF]
    if extra:
        names = ", ".join(language_name("en", lang) or lang for lang in extra)
        clauses.append(
            "Answer in the language the caller is speaking. Besides "
            f"{language_name('en', speaking) or speaking} you may switch into "
            f"{names} — begin the first sentence in the new language with "
            "[lang:XX] and stay there until the caller changes again.")
    else:
        clauses.append(
            f"This call is in {language_name('en', speaking) or speaking}. Stay in "
            "it even if the caller uses another language: no other voice is "
            "installed, and answering in one that cannot be spoken produces "
            "unusable audio.")
    if heard and _tag(heard) != speaking:
        clauses.append(f"The caller's last turn was heard as "
                       f"{language_name('en', heard) or _tag(heard)}.")
    return f"{agent.prompt}\n\n" + " ".join(clauses)


class LanguageTracker:
    """Which language the caller is in, and which one we are speaking.

    They are deliberately two things. ``caller`` is what the EAR reports and only
    ever informs the prompt; ``language`` is what the MOUTH speaks and moves only
    when the BRAIN says ``[lang:xx]``. Collapsing them was the first design here
    and it is wrong: the ear confirming Czech does not mean the brain answered in
    Czech, and a Czech voice reading an English sentence is precisely the
    mispronunciation this whole feature exists to refuse.

    On the ear side the guessing needs damping. faster-whisper's guess on two
    seconds of speech is a guess — one "ano" inside an English sentence comes
    back as Czech — so a caller switch needs ``CONFIRMATIONS`` consecutive
    utterances in the same new language, above a confidence floor, and it has to
    be a language the agent DECLARED (``Agent.languages``).

    Refusals are counted rather than dropped: "callers keep switching into a
    language this replica cannot speak" is the demand signal that says which
    Piper voice to install next, the same shape the emotion coverage loop uses.
    """

    CONFIRMATIONS = 2
    MIN_PROBABILITY = 0.5

    def __init__(self, agent: Agent):
        self.agent = agent
        self.language = _tag(agent.language) or "en"   # what we SPEAK
        self.caller = self.language                    # what we HEAR
        self.declined: dict[str, int] = {}
        self._candidate: str | None = None
        self._streak = 0

    def heard(self, language: str | None, probability: float = 1.0) -> str | None:
        """One utterance's detected language -> the caller's NEW language, or None.

        Reporting a switch does not move the mouth; it is what the brain gets
        told, so that the brain can decide (and say so with ``[lang:xx]``).
        """
        tag = _tag(language)
        if not tag or tag == self.caller or probability < self.MIN_PROBABILITY:
            self._candidate, self._streak = None, 0
            return None
        if not self.agent.honours(tag):
            self.declined[tag] = self.declined.get(tag, 0) + 1
            self._candidate, self._streak = None, 0
            return None
        self._streak = self._streak + 1 if tag == self._candidate else 1
        self._candidate = tag
        if self._streak < self.CONFIRMATIONS:
            return None
        self.caller, self._candidate, self._streak = tag, None, 0
        return tag

    def directed(self, language: str | None) -> str | None:
        """The BRAIN said ``[lang:xx]``. No hysteresis: it is explicit, not a guess.

        Returns the new spoken language when it is one the agent declared,
        otherwise None — an undeclared switch is a directive we cannot honour, and
        the caller hears ``switch_apology`` instead of the wrong phonemes.
        """
        tag = _tag(language)
        if not tag or tag == self.language:
            return None
        if not self.agent.honours(tag):
            self.declined[tag] = self.declined.get(tag, 0) + 1
            return None
        self.language = tag
        return tag


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------
class DialogBackend:
    """Given the turns so far, stream what the agent says next.

    Yields ``TurnPart``s — which are strings, so a consumer that only wants the
    words needs no change (see ``TurnPart``).
    """

    name = "base"

    async def reply(self, agent: Agent, history: list[dict]) -> AsyncIterator[TurnPart]:
        raise NotImplementedError
        yield TurnPart("")  # pragma: no cover - makes this an async generator

    def describe(self) -> dict:
        return {"backend": self.name}


class ScriptedBackend(DialogBackend):
    """Says the agent's script, one turn per call, regardless of the answers.

    Deterministic on purpose (see the module docstring). It ignores the
    candidate's words entirely, which is a feature for a latency or transcript
    test and useless for a realism test — pick the other backend for that.

    Turn index comes from the HISTORY, not from instance state, so the backend
    is stateless and one instance safely serves every concurrent session.
    """

    name = "scripted"

    # What a script CANNOT do, stated so it is not rediscovered as a bug: it
    # cannot react to what was actually said, and cannot answer a question.
    # Anything a test asserts about adaptive behaviour needs the model-backed
    # backend; this one is for the assertions that require the interviewer to be
    # identical every run.
    #
    # It CAN direct itself, though, since a script line goes through the same
    # buffer a model's deltas do: a line may carry the same inline directives
    # ("[lang:cs] Ahoj.", "[emotion:warm] Thanks for that.", "Goodbye.
    # [end_call]"), which is how a language-switch or end-of-call test stays
    # deterministic without a model.
    async def reply(self, agent: Agent, history: list[dict]) -> AsyncIterator[TurnPart]:
        spoken = sum(1 for m in history if m.get("role") == "assistant")
        # The first message is turn 0 and is sent by the session itself, so the
        # script picks up after however many turns the agent has already taken.
        idx = max(0, spoken - (1 if agent.first_message else 0))
        script = agent.script or [
            "Thank you, could you tell me more about that?",
            "That's everything I wanted to cover. Thanks for your time.",
        ]
        line = script[idx] if idx < len(script) else script[-1]
        for part in split_sentences(line):
            yield part


class OpenAiCompatBackend(DialogBackend):
    """Any server that speaks OpenAI ``/chat/completions`` — Ollama, LM Studio,
    llama.cpp, vLLM. Streamed, so sentence one is speakable before the model has
    finished thinking about sentence three.
    """

    name = "openai-compat"

    def __init__(self, base_url: str | None = None, model: str | None = None,
                 api_key: str | None = None):
        self.base_url = (base_url or SETTINGS.convai_llm_base_url).rstrip("/")
        self.model = model or SETTINGS.convai_llm_model
        self.api_key = api_key if api_key is not None else SETTINGS.convai_llm_api_key

    def describe(self) -> dict:
        return {"backend": self.name, "base_url": self.base_url, "model": self.model}

    async def reply(self, agent: Agent, history: list[dict]) -> AsyncIterator[TurnPart]:
        import httpx

        # History entries may carry annotations this service uses internally (the
        # language the caller was heard speaking, for one). They are stripped
        # here rather than at the call site: an OpenAI-compatible server is
        # entitled to reject a message object with fields it does not know.
        messages = [{"role": "system", "content": agent.prompt}] + [
            {"role": m.get("role", "user"), "content": m.get("content", "")}
            for m in history]
        payload = {"model": self.model, "messages": messages, "stream": True,
                   "temperature": agent.temperature,
                   "max_tokens": SETTINGS.convai_llm_max_tokens}
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        buf = _SentenceBuffer()
        try:
            async with httpx.AsyncClient(timeout=SETTINGS.convai_llm_timeout_s) as client:
                async with client.stream("POST", f"{self.base_url}/chat/completions",
                                         json=payload, headers=headers) as resp:
                    if resp.status_code >= 400:
                        body = (await resp.aread()).decode(errors="ignore")[:300]
                        raise DialogError(
                            f"the conversation model at {self.base_url} answered "
                            f"{resp.status_code}: {body}")
                    async for line in resp.aiter_lines():
                        for sentence in buf.push(_sse_delta(line)):
                            yield sentence
        except httpx.HTTPError as exc:
            raise DialogError(
                f"could not reach the conversation model at {self.base_url} "
                f"({type(exc).__name__}: {exc}). Set CONVAI_LLM_BASE_URL, or use "
                "CONVAI_LLM=scripted to run without one."
            ) from exc
        except asyncio.CancelledError:
            raise
        for sentence in buf.drain():
            yield sentence


class ClaudeCliBackend(DialogBackend):
    """The Claude CLI as the interviewer — a real model, no server to run.

    ``claude -p`` runs headless on the machine's own Claude subscription, so
    there is no API key to configure, no model to download and no inference
    server to keep alive. For a conversational agent that trade is the whole
    appeal: the quality of a frontier model with the operational footprint of a
    subprocess.

    What it costs is LATENCY. The CLI is a full agent harness — it boots Node,
    loads its configuration, and thinks before it answers — so a turn lands
    around 4-6 s against ~1.6 s for the scripted backend. Sentence streaming
    recovers some of it (synthesis starts on sentence one), but time-to-first-
    token dominates and no amount of pipelining hides it. Use this backend when
    the test is about BEHAVIOUR; use scripted when it is about latency.

    **It is deliberately disarmed.** A default ``claude -p`` session has Bash,
    Write, PowerShell and a scheduler available, which is not a thing that
    should be one hallucination away from an unattended interview. Two
    independent guards:

      * ``--disallowed-tools`` removes them from the session. Verified to
        actually shrink the tool list — unlike ``--allowed-tools``, which only
        decides what is PRE-APPROVED and leaves everything callable.
      * ``_TOOL_USE_REFUSED``: if a tool call appears anyway — a tool this list
        has never heard of, in some later CLI version — the turn is killed and
        fails loudly. The denylist reduces the chance; this is the guarantee,
        because it does not depend on knowing the tool's name.

    ``--system-prompt`` REPLACES Claude Code's own identity with the agent's
    brief, so the model is an interviewer rather than a coding assistant that
    has been asked to role-play one.
    """

    name = "claude-cli"

    # Everything that can touch the filesystem, the shell, the network, the
    # scheduler, other agents, or the user's attention. Enumerated because the
    # CLI has no "no tools" switch; backed by the tool_use guard below.
    DISALLOWED = (
        "Bash", "PowerShell", "Read", "Write", "Edit", "NotebookEdit",
        "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Skill", "Workflow",
        "ToolSearch", "CronCreate", "CronDelete", "CronList", "Monitor",
        "PushNotification", "RemoteTrigger", "ScheduleWakeup", "SendMessage",
        "DesignSync", "EnterWorktree", "ExitWorktree", "ReportFindings",
        "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop",
        "TaskUpdate",
    )

    _OUTPUT_RULE = (
        "Reply with ONLY the words you would say out loud on the call. No stage "
        "directions, no markdown, no preamble, no explanation of your reasoning."
    )

    def __init__(self, command: str | None = None, model: str | None = None,
                 timeout_s: float | None = None):
        self.command = command or SETTINGS.claude_cli_command
        self.model = model or SETTINGS.claude_cli_model
        self.timeout_s = timeout_s or SETTINGS.claude_cli_timeout_s

    def describe(self) -> dict:
        return {"backend": self.name, "command": self.command,
                "model": self.model or "cli default"}

    def available(self) -> bool:
        import shutil

        return bool(shutil.which(self.command)) or Path(self.command).is_file()

    def _executable(self) -> str:
        """Resolve the command to a launchable path.

        On Windows an npm-installed ``claude`` is a ``.CMD`` shim, and
        CreateProcess does not apply PATHEXT — so the bare name fails while the
        resolved path works. The prompt travels over stdin, never argv, so the
        ``.cmd`` quoting hazards do not apply.
        """
        import shutil

        resolved = shutil.which(self.command)
        if resolved:
            return resolved
        if Path(self.command).is_file():
            return self.command
        raise DialogError(
            f"the Claude CLI was not found (command={self.command!r}). Install it, "
            "put it on PATH, or set CONVAI_LLM=scripted to run without a model.")

    def _argv(self, agent: Agent) -> list[str]:
        argv = [self._executable(), "-p",
                "--output-format", "stream-json",
                "--include-partial-messages",
                "--verbose",              # required alongside stream-json
                "--system-prompt", f"{agent.prompt}\n\n{self._OUTPUT_RULE}",
                # Load no project settings: an interviewer should not inherit
                # this checkout's skills, hooks or MCP servers.
                "--setting-sources", "",
                "--strict-mcp-config",
                "--exclude-dynamic-system-prompt-sections",
                "--disallowed-tools", *self.DISALLOWED]
        if self.model:
            argv += ["--model", self.model]
        return argv

    @staticmethod
    def _transcript(agent: Agent, history: list[dict]) -> str:
        lines = []
        for m in history:
            # main's counterpart naming + the branch's heard-language tag,
            # composed: an agent that IS the candidate must not call the
            # interviewer one, and the model still cannot follow the caller
            # into another language if nobody tells it which one they used.
            who = "You" if m.get("role") == "assistant" else agent.counterpart
            heard = _tag(m.get("language")) if m.get("role") != "assistant" else ""
            tag = f" [{heard}]" if heard else ""
            lines.append(f"{who}{tag}: {m.get('content', '')}")
        body = "\n".join(lines) if lines else "(the call has just connected)"
        return (f"This is a spoken interview in progress.\n\n{body}\n\n"
                "Say your next turn.")

    async def reply(self, agent: Agent, history: list[dict]) -> AsyncIterator[TurnPart]:
        argv = self._argv(agent)
        env = dict(os.environ)
        # Run on the interactive subscription, not metered API billing — the
        # same reasoning kp's ClaudeCliProvider documents.
        for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
            env.pop(key, None)
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env=env)
        except (OSError, ValueError) as exc:
            raise DialogError(f"could not start the Claude CLI ({exc})") from exc

        buf = _SentenceBuffer()
        try:
            proc.stdin.write(self._transcript(agent, history).encode("utf-8"))
            await proc.stdin.drain()
            proc.stdin.close()
            async for sentence in self._stream(proc, buf):
                yield sentence
            for sentence in buf.drain():
                yield sentence
        finally:
            # A turn can be cancelled mid-reply by a barge-in, and an orphaned
            # CLI would keep thinking (and keep spending) with nobody listening.
            if proc.returncode is None:
                proc.kill()
                with contextlib.suppress(ProcessLookupError, OSError):
                    await proc.wait()

    async def _stream(self, proc, buf: "_SentenceBuffer") -> AsyncIterator[TurnPart]:
        deadline = SETTINGS.claude_cli_timeout_s
        saw_text = False
        while True:
            try:
                raw = await asyncio.wait_for(proc.stdout.readline(), timeout=deadline)
            except asyncio.TimeoutError:
                raise DialogError(
                    f"the Claude CLI produced nothing for {deadline:.0f}s; giving up "
                    "on this turn (raise CLAUDE_CLI_TIMEOUT_S, or use "
                    "CONVAI_LLM=scripted)")
            if not raw:
                break
            event = _json_line(raw)
            if event is None:
                continue
            if _is_tool_use(event):
                # See the class docstring: the guarantee that does not depend on
                # knowing a tool's name.
                raise DialogError(
                    "the Claude CLI tried to use a tool during a conversation "
                    f"({_tool_name(event)}); the turn was stopped. An interviewer "
                    "runs with tools disabled — this is a denylist gap, please "
                    "report it.")
            for sentence in buf.push(_text_delta(event)):
                saw_text = True
                yield sentence
        code = await proc.wait()
        if code != 0 and not saw_text and not buf.pending():
            detail = (await proc.stderr.read()).decode("utf-8", "replace")[:300]
            raise DialogError(f"the Claude CLI exited {code}: {detail or 'no output'}")


def _json_line(raw: bytes) -> dict | None:
    try:
        parsed = json.loads(raw.decode("utf-8", "replace"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _text_delta(event: dict) -> str:
    """The spoken text carried by one CLI stream event.

    ``thinking_delta`` is deliberately NOT included: the model's reasoning is
    not part of what the agent says out loud, and streaming it would put it in
    the transcript and through the synthesizer.
    """
    delta = ((event.get("event") or {}).get("delta") or {})
    if delta.get("type") == "text_delta":
        return str(delta.get("text") or "")
    return ""


def _is_tool_use(event: dict) -> bool:
    inner = event.get("event") or {}
    if (inner.get("content_block") or {}).get("type") == "tool_use":
        return True
    message = event.get("message") or {}
    content = message.get("content")
    if isinstance(content, list):
        return any(isinstance(b, dict) and b.get("type") == "tool_use" for b in content)
    return False


def _tool_name(event: dict) -> str:
    inner = event.get("event") or {}
    block = inner.get("content_block") or {}
    if block.get("type") == "tool_use":
        return str(block.get("name") or "unknown")
    for b in (event.get("message") or {}).get("content") or []:
        if isinstance(b, dict) and b.get("type") == "tool_use":
            return str(b.get("name") or "unknown")
    return "unknown"


def _sse_delta(line: str) -> str:
    """The text carried by one server-sent-event line, or "" for everything
    else (keep-alives, the ``[DONE]`` sentinel, framing)."""
    line = line.strip()
    if not line.startswith("data:"):
        return ""
    data = line[5:].strip()
    if not data or data == "[DONE]":
        return ""
    try:
        chunk = json.loads(data)
    except json.JSONDecodeError:
        return ""
    choices = chunk.get("choices") or []
    if not choices:
        return ""
    delta = choices[0].get("delta") or {}
    return str(delta.get("content") or "")


def make_backend(kind: str | None = None) -> DialogBackend:
    """The brain this replica is configured to run.

    An unknown name falls back to scripted with a loud log rather than failing
    the session: a typo in an env var should not look like a broken agent.
    """
    kind = (kind or SETTINGS.convai_llm or "scripted").strip().lower()
    if kind in ("scripted", "script", "canned"):
        return ScriptedBackend()
    if kind in ("openai-compat", "openai", "ollama", "llm"):
        return OpenAiCompatBackend()
    if kind in ("claude-cli", "claude", "cli"):
        backend = ClaudeCliBackend()
        if not backend.available():
            logger.error(
                "CONVAI_LLM=%s but the Claude CLI (%s) is not on PATH; falling back "
                "to the scripted backend so conversations still work", kind,
                backend.command)
            return ScriptedBackend()
        return backend
    logger.error("unknown CONVAI_LLM=%r; falling back to the scripted backend", kind)
    return ScriptedBackend()
