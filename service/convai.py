"""Conversational agent — the ElevenLabs Agents WebSocket, served locally.

The rest of this service is request/response: text in, audio out. A spoken
conversation is not that shape. It is a duplex socket where the caller's
microphone never stops, the agent has to work out on its own when a turn ended,
and being interrupted is a normal event rather than an error. This module is
that socket, wired to the three local parts that make it free: ``service.vad``
decides where the turns are, ``service.stt`` hears them, ``service.dialog``
answers, and the existing TTS pool speaks.

**Why this protocol and not a new one.** Applications that want spoken AI are
already written against ElevenLabs Agents — a signed WebSocket URL from the
server, then ``@elevenlabs/react`` in the browser. Their integration point is
one URL constant. Speaking their wire protocol means an app repoints at
localhost and keeps its consent flow, its transcript storage, its failover and
its tests; inventing a cleaner protocol would mean rewriting all of that, and
per-minute cloud billing is not the part anybody wanted to keep.

The exchange, client to server unless noted::

    ->  {"type": "conversation_initiation_client_data",
         "conversation_config_override": {"agent": {...}}}      (optional)
    <-  {"type": "conversation_initiation_metadata", ...}       conversation id + formats
    ->  {"user_audio_chunk": "<base64 PCM16 mono>"}             continuously, in real time
    <-  {"type": "user_transcript", ...}                        what we heard them say
    <-  {"type": "agent_response", ...}                         the whole reply, as text
    <-  {"type": "audio", ...}                                  that reply, as PCM16 chunks
    <-  {"type": "interruption", ...}                           they talked over the agent
    <-  {"type": "ping", ...}   ->  {"type": "pong", ...}       liveness

**Text before audio.** ``agent_response`` carries the complete reply and is
sent BEFORE its audio, because that is the order clients depend on. It would
be lower latency to emit text per sentence as the model writes it, but a client
that records one turn per ``agent_response`` would then store a fragmented
transcript. So the text waits for the model to finish while synthesis does NOT:
sentences are rendered as they arrive, and the finished audio is held until the
text event goes out. The reply costs roughly what the language model costs, and
the speech is already made by the time it is allowed to be sent.

**Authentication is a ticket, not a header.** A browser cannot put an API key
on a WebSocket handshake — which is exactly why ElevenLabs mints a signed URL
over HTTP first. So does this: ``/v1/convai/conversation/get-signed-url`` is
scope-checked like every other route and returns a short-lived HMAC ticket, and
the socket accepts nothing else.

**Speculation, all of it optional.** A turn costs its parts strictly in series
after the caller falls silent: decode, then think, then synthesize. Four
config-flagged speculations overlap those costs with the caller's own speech
(see the CONVAI_PARTIAL_DECODE block in service/config.py). Every one is OFF by
default and every one obeys the same rule, which is the only reason they are
safe to have at all:

    a speculation is invisible until the turn is confirmed.

Concretely: a partial transcript is never written to ``history`` or to the
recorded transcript (it is noisier than a final one, by construction); a
speculative reply is buffered and discarded unheard if the caller resumes or if
the final transcript does not continue the prefix it was built on; an opener is
a content-free backchannel that plays only after words were actually heard, is
not a turn and enters no transcript. What speculation may cost is CPU. What it
must never cost is a sentence the agent did not mean.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import dataclasses
import hmac
import io
import json
import logging
import secrets
import time
import uuid
import wave
from hashlib import sha256
from typing import AsyncIterator, Callable, Iterable

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

from service import dialog, piper, recording, stt
from service.cache import CachedPcm, SynthCache
from service.config import SETTINGS
from service.engine import resample_pcm16
from service.recording import Recorder, Turn
from service.vad import (SPEECH_END, SPEECH_START, SpeechGate, Utterance,
                         frame_db)

logger = logging.getLogger("gravitone.convai")

router = APIRouter(tags=["convai"])
# The socket is a SEPARATE router because it is authenticated differently: the
# HTTP router is mounted under a scope dependency, and applying that same
# dependency to a WebSocket would demand a header the browser cannot send.
ws_router = APIRouter(tags=["convai"])

# Audio is handed to the client in chunks this long. Playback pacing is the
# client's job (it buffers and plays on its own clock), so this is only about
# not building one enormous frame: small enough that an interruption stops the
# stream promptly, large enough that a reply is not thousands of messages.
CHUNK_MS = 200
# Turns kept in the prompt. A screening interview is well under this; the cap
# exists so a session that runs for an hour cannot grow its prompt without end.
_HISTORY_MAX = 40
# How long the socket waits for the client's opening message before proceeding
# with the agent's own configuration. Clients that send nothing are valid.
_INIT_WAIT_S = 2.0

# Signing key for connect tickets. When a root key is configured the ticket is
# bound to it, so tickets do not survive a key rotation. In open local dev there
# is no root key and a per-PROCESS random secret is used instead — which means
# tickets are not valid across replicas. That is correct rather than convenient:
# a ticket is a connect permit for the box that minted it.
_TICKET_SECRET = (SETTINGS.api_key or secrets.token_hex(32)).encode()

# Set by service.app so this module can reach the worker pool without importing
# the app (which imports this router — the cycle that would create).
_engine_provider: Callable[[], object | None] = lambda: None


def set_engine_provider(provider: Callable[[], object | None]) -> None:
    global _engine_provider
    _engine_provider = provider


# The brain is built once and shared: both backends are stateless per call (the
# scripted one derives its position from the history it is handed), so there is
# nothing per-session to keep.
_BACKEND: dialog.DialogBackend | None = None


def backend() -> dialog.DialogBackend:
    global _BACKEND
    if _BACKEND is None:
        _BACKEND = dialog.make_backend()
        logger.info("convai brain: %s", _BACKEND.describe())
    return _BACKEND


# ---------------------------------------------------------------------------
# Speculation: openers, agreed prefixes, and what is switched on
# ---------------------------------------------------------------------------
# Openers live in their OWN SynthCache instance rather than the HTTP one: the
# entries are raw PCM at a wire rate (not WAVs), the budget is tiny, and an
# opener must never be evicted by a burst of unrelated synthesis traffic — being
# already-rendered is the entire point of it.
_OPENER_CACHE: "SynthCache[CachedPcm] | None" = None
_OPENER_BUDGET = -1


def opener_cache() -> "SynthCache[CachedPcm]":
    """The process's opener cache, resized in place if the budget changed."""
    global _OPENER_CACHE, _OPENER_BUDGET
    budget = max(0, SETTINGS.convai_opener_cache_bytes)
    if _OPENER_CACHE is None:
        _OPENER_CACHE = SynthCache(budget)
    elif budget != _OPENER_BUDGET:
        _OPENER_CACHE.resize(budget)
    _OPENER_BUDGET = budget
    return _OPENER_CACHE


def _opener_agents() -> set[str]:
    return {part.strip() for part in SETTINGS.convai_opener_agents.split(",")
            if part.strip()}


def opener_phrases() -> list[str]:
    """The rotation, in order. Content-free by contract — see config.py."""
    return [part.strip() for part in SETTINGS.convai_opener_phrases.split("|")
            if part.strip()]


def openers_enabled(agent_id: str) -> bool:
    """Whether THIS agent takes the floor with a pre-rendered backchannel.

    Two switches, because they answer different questions: ``CONVAI_OPENERS`` is
    the replica's (it costs CPU and cache), ``CONVAI_OPENER_AGENTS`` is the
    agent's (an interviewer wants a "Mm-hm."; a legal read-back must not have
    one). An empty agent list means every agent, so the common case is one flag.
    """
    if not SETTINGS.convai_openers:
        return False
    named = _opener_agents()
    return not named or agent_id in named


def speculation_flags() -> dict:
    """Which speculations are live on this replica, for the agents surface.

    Reported because they are otherwise invisible: two replicas running the same
    agent can have very different turn latency and neither transcript would say
    why. ``opener_agents`` empty means "every agent".
    """
    return {
        "partial_decode": SETTINGS.convai_partial_decode,
        "partial_interval_ms": SETTINGS.convai_partial_interval_ms,
        "speculate": SETTINGS.convai_speculate,
        "openers": SETTINGS.convai_openers,
        "opener_agents": sorted(_opener_agents()),
        "echo_suppression": SETTINGS.convai_echo_suppression,
    }


def agreed_prefix(partials: list[str]) -> str:
    """The prefix the last two partial transcripts agree on, at a word boundary.

    Two consecutive decodes saying the same thing about the same span is the
    cheapest available evidence that Whisper has stopped changing its mind about
    it. A half-word is dropped rather than kept: "what is your exper" is a worse
    thing to hand a language model than "what is your", because it reads as a
    typo instead of as an unfinished sentence.
    """
    if len(partials) < 2:
        return ""
    older, newer = partials[-2], partials[-1]
    shared = 0
    for a, b in zip(older, newer):
        if a != b:
            break
        shared += 1
    prefix = older[:shared]
    if shared < len(older) or shared < len(newer):
        cut = prefix.rfind(" ")
        prefix = prefix[:cut] if cut > 0 else ""
    return prefix.strip()


def _normalize(text: str) -> str:
    """Text as it is COMPARED: case and punctuation carry no information here."""
    kept = [c.lower() if c.isalnum() else " " for c in text]
    return " ".join("".join(kept).split())


def continues(final_text: str, prefix: str) -> bool:
    """Whether the confirmed transcript really is a continuation of ``prefix``.

    The test a speculation has to pass before anything it produced may be
    spoken. Compared on normalized text because a partial and a final decode of
    the same words routinely disagree about a comma.
    """
    prefix_n = _normalize(prefix)
    return bool(prefix_n) and _normalize(final_text).startswith(prefix_n)


def _distribution(values: list[float]) -> dict:
    """n / min / median / max, or just ``n: 0``. No invented numbers."""
    if not values:
        return {"n": 0}
    ordered = sorted(values)
    mid = len(ordered) // 2
    median = (ordered[mid] if len(ordered) % 2
              else (ordered[mid - 1] + ordered[mid]) / 2)
    return {"n": len(ordered), "min": round(ordered[0], 3),
            "median": round(median, 3), "max": round(ordered[-1], 3)}


class _Speculation:
    """One reply written for a transcript the caller had not finished saying.

    Holds text and nothing else. It has no send path by construction: the only
    way its sentences reach a socket is ``_Session._answer`` deciding, after the
    final transcript is in, that the guess it was built on was right.
    """

    __slots__ = ("prefix", "task", "sentences", "done")

    def __init__(self, prefix: str) -> None:
        self.prefix = prefix
        self.task: asyncio.Task | None = None
        self.sentences: list[str] = []
        self.done = False


# ---------------------------------------------------------------------------
# Connect tickets
# ---------------------------------------------------------------------------
def mint_ticket(agent_id: str, ttl_s: int | None = None) -> str:
    """A short-lived permit to open ONE socket for ``agent_id``.

    Shape: ``{expiry}.{nonce}.{hmac}``. The agent id is signed too, so a ticket
    for a cheap agent cannot be replayed against an expensive one.
    """
    exp = int(time.time()) + int(ttl_s if ttl_s is not None else SETTINGS.convai_ticket_ttl_s)
    nonce = secrets.token_urlsafe(9)
    return f"{exp}.{nonce}.{_sign(agent_id, exp, nonce)}"


def verify_ticket(agent_id: str, ticket: str | None) -> bool:
    """Whether this ticket authorizes this agent, right now."""
    if not ticket:
        return False
    try:
        exp_s, nonce, sig = ticket.split(".", 2)
        exp = int(exp_s)
    except (ValueError, AttributeError):
        return False
    if exp < time.time():
        return False
    return hmac.compare_digest(sig, _sign(agent_id, exp, nonce))


def _sign(agent_id: str, exp: int, nonce: str) -> str:
    payload = f"{agent_id}|{exp}|{nonce}".encode()
    return hmac.new(_TICKET_SECRET, payload, sha256).hexdigest()[:32]


def _ws_base(request: Request) -> str:
    """The ws:// origin a client should dial back on.

    Derived from the request the client just made, so a direct connection is
    right with no configuration. ``CONVAI_PUBLIC_URL`` overrides it for the case
    the request cannot describe: a reverse proxy or a container port map, where
    the address this process sees is not the address the browser used.
    """
    base = (SETTINGS.convai_public_url or "").strip().rstrip("/")
    if not base:
        scheme = "wss" if request.url.scheme in ("https", "wss") else "ws"
        return f"{scheme}://{request.url.netloc}"
    for prefix, ws in (("https://", "wss://"), ("http://", "ws://")):
        if base.startswith(prefix):
            return ws + base[len(prefix):]
    return base


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------
def _describe_agent(agent: dialog.Agent) -> dict:
    """One agent as the API reports it, including whether it can be SPOKEN.

    The resolved voice is reported rather than the configured one, because for a
    non-English agent those differ — and an agent whose language has no voice
    installed says so here instead of failing when someone dials it.
    """
    described = {"agent_id": agent.agent_id, "name": agent.name,
                 "language": agent.language, "first_message": agent.first_message,
                 "scripted_turns": len(agent.script), "keywords": agent.keywords,
                 "allow_overrides": agent.allow_overrides}
    described["languages"] = _speakable_matrix(agent)
    try:
        voice, is_piper = _resolve_voice(agent)
    except VoiceUnavailable as exc:
        return dict(described, voice_id=None, tts=None, speakable=False,
                    problem=str(exc))
    return dict(described, voice_id=voice,
                tts="piper" if is_piper else "pocket-tts", speakable=True)


def _speakable_matrix(agent: dialog.Agent) -> dict:
    """Every language this agent declared, and whether there is a mouth for it.

    A boolean cannot describe a bilingual agent: "speakable" for an agent that
    speaks English and would follow a caller into Czech is both true and useless.
    The matrix is resolved through the SAME rule the session uses, so what this
    surface promises is exactly what a mid-call switch will find.
    """
    matrix: dict[str, dict] = {}
    base = dialog.language_tag(agent.language)
    for tag in agent.switch_languages():
        probe = agent if tag == base else dataclasses.replace(
            agent, language=tag, voice_id="")
        try:
            voice, is_piper = _resolve_voice(probe)
        except VoiceUnavailable as exc:
            matrix[tag] = {"speakable": False, "voice_id": None, "tts": None,
                           "problem": str(exc)}
            continue
        matrix[tag] = {"speakable": True, "voice_id": voice,
                       "tts": "piper" if is_piper else "pocket-tts"}
    return matrix


@router.get("/v1/convai/agents")
def list_agents() -> dict:
    """Every agent this replica can run, and which brain answers for them.

    The brain is reported because it is the one thing about a conversation that
    is invisible from the outside: a scripted agent and a language-model agent
    speak the same protocol in the same voice, and only this says which one just
    talked to you.
    """
    return {
        "agents": [_describe_agent(a) for a in dialog.list_agents()],
        "brain": backend().describe(),
        "stt": stt.info(),
        "piper": piper.info(),
        "audio_format": f"pcm_{SETTINGS.convai_audio_rate}",
        "enabled": SETTINGS.convai_enabled,
        "sessions": {"active": _Sessions.active, "max": SETTINGS.convai_max_sessions},
        # Which turn-taking speculations this replica runs. All off by default;
        # they change how a turn FEELS without changing what it says.
        "speculation": speculation_flags(),
    }


@router.get("/v1/convai/conversations")
def list_conversations(limit: int = Query(50, ge=1, le=200)) -> dict:
    """Recorded conversations, newest first. Empty when recording is off."""
    return {"recording": SETTINGS.convai_record,
            "directory": str(recording.recordings_dir()),
            "conversations": recording.listing(limit)}


@router.get("/v1/convai/conversations/{conversation_id}")
def get_conversation(conversation_id: str) -> dict:
    """One conversation's transcript: every turn, with what it cost.

    The audio sits next to it on disk (``user.wav`` / ``agent.wav``, sharing one
    timeline) and is deliberately NOT served here — a recording of someone's
    voice is not something this surface hands out on an id guess.
    """
    found = recording.load(conversation_id)
    if found is None:
        raise HTTPException(404, f"no recorded conversation '{conversation_id}'. "
                                 "Recording is off unless CONVAI_RECORD=1.")
    return found


@router.get("/v1/convai/conversation/get-signed-url")
def get_signed_url(request: Request, agent_id: str = Query(...)) -> dict:
    """Mint the URL a client opens its conversation on (ElevenLabs-shaped).

    This is the ONE call an existing ElevenLabs integration has to repoint; the
    socket it hands back speaks the protocol the SDK already knows.
    """
    if not SETTINGS.convai_enabled:
        raise HTTPException(503, "conversational agents are disabled on this "
                                 "service (CONVAI_ENABLED=0)")
    agent = dialog.get_agent(agent_id)
    if agent is None:
        known = ", ".join(a.agent_id for a in dialog.list_agents()) or "none"
        raise HTTPException(404, f"unknown agent '{agent_id}'. Available: {known}")
    ticket = mint_ticket(agent.agent_id)
    url = (f"{_ws_base(request)}/v1/convai/conversation"
           f"?agent_id={agent.agent_id}&token={ticket}")
    return {"signed_url": url, "expires_in_s": SETTINGS.convai_ticket_ttl_s}


# ---------------------------------------------------------------------------
# Session accounting
# ---------------------------------------------------------------------------
class _Sessions:
    """How many conversations this replica is holding.

    Over the cap the socket is CLOSED rather than queued: a caller waiting in
    line for a live conversation has already had the conversation fail, so
    saying so immediately is the kinder answer (and the one a failover layer can
    act on).
    """

    active = 0

    @classmethod
    def take(cls) -> bool:
        if cls.active >= SETTINGS.convai_max_sessions:
            return False
        cls.active += 1
        return True

    @classmethod
    def give_back(cls) -> None:
        cls.active = max(0, cls.active - 1)


# WebSocket close codes. 1011 = the server failed; 1013 = try again later.
_CLOSE_INTERNAL = 1011
_CLOSE_BUSY = 1013
_CLOSE_POLICY = 1008
# 1000 = the conversation ENDED, normally. The agent saying goodbye is not a
# failure and must not be reported as one.
_CLOSE_NORMAL = 1000


@ws_router.websocket("/v1/convai/conversation")
async def conversation(websocket: WebSocket, agent_id: str = Query(...),
                       token: str | None = Query(None)) -> None:
    """One spoken conversation.

    Everything is refused BEFORE the socket is accepted where possible, so a
    rejected client gets a handshake failure rather than a connection that
    opens and then dies for reasons it has to guess at.
    """
    if not SETTINGS.convai_enabled:
        await websocket.close(code=_CLOSE_POLICY, reason="conversational agents are disabled")
        return
    if not verify_ticket(agent_id, token):
        await websocket.close(code=_CLOSE_POLICY,
                              reason="invalid or expired signed URL")
        return
    agent = dialog.get_agent(agent_id)
    if agent is None:
        await websocket.close(code=_CLOSE_POLICY, reason=f"unknown agent '{agent_id}'")
        return
    if not _Sessions.take():
        await websocket.close(code=_CLOSE_BUSY, reason="this service is at its "
                                                       "conversation limit")
        return
    session = _Session(websocket, agent)
    try:
        await session.run()
    finally:
        _Sessions.give_back()


# ---------------------------------------------------------------------------
# The session
# ---------------------------------------------------------------------------
# Languages Pocket TTS can actually speak. Anything else needs a Piper voice
# (service/piper.py); see _resolve_voice.
_POCKET_LANGUAGES = frozenset({"en", "fr"})


class VoiceUnavailable(RuntimeError):
    """The agent names a voice this replica cannot speak. Authored for the
    operator: the message says exactly what to download."""


def _resolve_voice(agent: dialog.Agent) -> tuple[str, bool]:
    """Which voice speaks for this agent, and whether Piper owns it.

    The rule, in order:

      1. An explicitly named Piper voice wins — the operator was specific.
      2. Any other explicitly named voice goes to the Pocket TTS pool.
      3. Otherwise, if the agent's LANGUAGE is one Pocket TTS cannot speak, find
         a Piper voice for it. This is what lets a Czech agent be configured
         with nothing but ``"language": "cs"``.
      4. Otherwise the service default.

    Rule 3 is the one that matters. Without it a Czech agent fell through to an
    English voice and read Czech words with English phonemes — a conversation
    that "worked" and was unlistenable, which is worse than one that refuses.
    """
    named = (agent.voice_id or "").strip()
    if named:
        return (named, True) if piper.has_voice(named) else (named, False)

    language = (agent.language or "en").split("-", 1)[0].lower()
    if language not in _POCKET_LANGUAGES:
        found = piper.voice_for_language(language)
        if found:
            return found, True
        raise VoiceUnavailable(
            f"agent '{agent.agent_id}' speaks {language!r}, which Pocket TTS "
            f"cannot synthesize (it speaks {sorted(_POCKET_LANGUAGES)}), and no "
            f"Piper voice for {language!r} is installed. Download one into "
            f"{piper.voices_dir()} — e.g. `python -m piper.download_voices "
            f"--download-dir {piper.voices_dir()} cs_CZ-jirka-medium` — or give "
            "the agent an explicit voice_id.")
    return SETTINGS.default_voice, False


def _warm_ears() -> None:
    """Load the transcriber, off the event loop, failing quietly.

    A missing or broken model is NOT reported here: it would be reported twice,
    and the place that can say something useful about it is the turn that
    actually needed to hear something (``_Session._answer``, which closes the
    socket with the reason). This is an optimization, so its failure mode is
    "the first turn is slow", not "the conversation dies at connect".
    """
    try:
        stt.load_model()
    except stt.SttUnavailable as exc:
        logger.warning("convai: could not pre-load the transcriber (%s)", exc)


def wav_to_pcm(wav_bytes: bytes, dst_rate: int) -> bytes:
    """WAV from the synthesis pool -> raw PCM16 at the conversation's rate."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())
    samples = np.frombuffer(frames, dtype="<i2")
    if rate != dst_rate:
        samples = resample_pcm16(samples, rate, dst_rate)
    return samples.tobytes()


class _Session:
    """One conversation: its ears, its history, and its one turn in flight."""

    def __init__(self, websocket: WebSocket, agent: dialog.Agent):
        self.ws = websocket
        self.agent = agent
        self.conversation_id = uuid.uuid4().hex[:22]
        self.rate = SETTINGS.convai_audio_rate
        self.gate = SpeechGate(self.rate)
        self.history: list[dict] = []
        # Resolved in run(), AFTER any client override has been folded in — an
        # override may change the voice, and resolving before that would pick a
        # mouth for an agent that no longer exists.
        self.voice = ""
        self.is_piper = False
        # Which language we are SPEAKING and which one we are HEARING — two
        # different things (see dialog.LanguageTracker). Rebuilt in run() once
        # overrides have landed, because an override may change both.
        self.languages = dialog.LanguageTracker(agent)
        # Resolved mouths per language, so switching back and forth does not
        # re-walk the voice directory every sentence.
        self._mouths: dict[str, tuple[str, bool]] = {}
        # Languages we have already apologized for. One refusal per language per
        # call: a whole Czech reply must not become five identical apologies.
        self._refused: set[str] = set()

        self._send_lock = asyncio.Lock()   # several tasks send; frames must not interleave
        self._turn: asyncio.Task | None = None
        self._event_id = 0
        self._ping_id = 0
        self._unanswered_pings = 0
        self._started = time.monotonic()
        self._last_activity = time.monotonic()
        self._turns = 0
        self._closing = False
        # How the conversation ended, for the recording. "hung_up" is the
        # default because a client that simply disconnects never tells us
        # anything; every other ending replaces it with the reason we gave.
        self._ended = "hung_up"
        self._warming: asyncio.Future | None = None
        self._prewarming: asyncio.Future | None = None
        self.recorder = Recorder(self.conversation_id, self.rate)

        # -- speculation (all inert unless the flags are on) ----------------
        self._partial_task: asyncio.Task | None = None
        self._partial_at = 0.0            # monotonic time of the last partial
        # The last two partial transcripts of the utterance in progress. This is
        # the ONLY place partial text is kept, and it is cleared at every turn
        # boundary: it is evidence about a guess, not a record of anything.
        self._partials: list[str] = []
        self._spec: _Speculation | None = None
        self._stats = {"partials_run": 0, "partials_empty": 0,
                       "partials_dropped": 0, "interims_sent": 0,
                       "speculations": 0, "speculations_used": 0,
                       "speculations_discarded": 0, "openers_sent": 0}

    # -- lifecycle ----------------------------------------------------------
    async def run(self) -> None:
        await self.ws.accept()
        watchdog = asyncio.create_task(self._watchdog())
        try:
            override, pending = await self._read_init()
            self.agent = dialog.apply_overrides(self.agent, override)
            try:
                self.voice, self.is_piper = _resolve_voice(self.agent)
            except VoiceUnavailable as exc:
                # Refused at connect rather than discovered on the first reply:
                # a conversation that cannot be spoken should not be started.
                logger.error("convai %s: %s", self.conversation_id, exc)
                await self._close(_CLOSE_POLICY, str(exc)[:120])
                return
            # Rebuilt now: the tracker's base language is the OVERRIDDEN agent's.
            self.languages = dialog.LanguageTracker(self.agent)
            await self._send({
                "type": "conversation_initiation_metadata",
                "conversation_initiation_metadata_event": {
                    "conversation_id": self.conversation_id,
                    "agent_output_audio_format": f"pcm_{self.rate}",
                    "user_input_audio_format": f"pcm_{self.rate}",
                },
            })
            logger.info("convai %s open: agent=%s voice=%s (%s) language=%s brain=%s",
                        self.conversation_id, self.agent.agent_id, self.voice,
                        "piper" if self.is_piper else "pocket-tts",
                        self.agent.language, backend().name)
            self.recorder.note(conversation_id=self.conversation_id,
                               agent_id=self.agent.agent_id,
                               voice_id=self.voice,
                               tts="piper" if self.is_piper else "pocket-tts",
                               language=self.agent.language,
                               languages=self.agent.switch_languages(),
                               brain=backend().describe(), stt=stt.describe_model())
            # Load the transcriber NOW, on a thread, rather than on the first
            # thing the caller says. It is a ~2 s load from a warm cache, and
            # paying it inside the first turn made the opening exchange of every
            # fresh conversation visibly slower than the rest of it. Here it
            # overlaps the agent's greeting — seconds the caller spends
            # listening — so by the time they answer, the ear is open.
            self._warming = asyncio.ensure_future(
                asyncio.get_event_loop().run_in_executor(None, _warm_ears))
            # Keep the SECOND mouth hot for the same reason. The first sentence
            # after a language switch is the one moment this feature is judged,
            # and a cold ONNX load lands exactly there; here it overlaps the
            # greeting instead. Fire-and-forget, and piper.prewarm reports rather
            # than raises — an optimization must not be able to fail a connect.
            declared = [lang for lang in self.agent.switch_languages()
                        if lang != dialog.language_tag(self.agent.language)]
            if declared:
                self._prewarming = asyncio.ensure_future(
                    asyncio.get_event_loop().run_in_executor(
                        None, piper.prewarm, declared))
            if self.agent.first_message:
                self._begin_turn(self._opening())
            if pending is not None:
                await self._dispatch(pending)
            await self._read_loop()
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # noqa: BLE001 - a dead session must SAY why
            logger.exception("convai %s failed", self.conversation_id)
            await self._close(_CLOSE_INTERNAL, f"session error: {type(exc).__name__}")
        finally:
            self._closing = True
            watchdog.cancel()
            if self._partial_task is not None:
                self._partial_task.cancel()
            await self._cancel_speculation("session closed")
            await self._cancel_turn(interrupt=False)
            self.recorder.note(turns=self._turns)
            self._publish_latency()
            self.recorder.close(self._ended)
            logger.info("convai %s closed after %.1fs, %d turn(s)",
                        self.conversation_id, time.monotonic() - self._started,
                        self._turns)

    async def _read_init(self) -> tuple[dict | None, dict | None]:
        """The client's opening message: ``(agent override, message to replay)``.

        ElevenLabs' own clients send ``conversation_initiation_client_data``
        immediately; the headless test driver does too. A client that sends
        nothing is not broken, it just accepted the agent as configured — so a
        timeout here proceeds rather than fails.

        A first message that is already AUDIO is handed back to be replayed
        after the handshake rather than processed here, so that no turn can
        begin before the client has been told the conversation's id and audio
        format.
        """
        try:
            msg = await asyncio.wait_for(self._receive(), timeout=_INIT_WAIT_S)
        except asyncio.TimeoutError:
            return None, None
        if msg is None:
            # Hung up before saying anything. Raised rather than returned so the
            # handshake below is never attempted on a socket that is already gone.
            raise WebSocketDisconnect(code=1000)
        if msg.get("type") == "conversation_initiation_client_data":
            return (msg.get("conversation_config_override") or {}).get("agent"), None
        return None, msg

    async def _read_loop(self) -> None:
        while True:
            msg = await self._receive()
            if msg is None:
                return
            await self._dispatch(msg)

    async def _receive(self) -> dict | None:
        """One decoded client message, or None when the socket is done.

        Undecodable frames are dropped with a log instead of killing the
        conversation: one malformed message from a client should not end a call.
        """
        raw = await self.ws.receive()
        kind = raw.get("type")
        if kind == "websocket.disconnect":
            return None
        text = raw.get("text")
        if text is None:
            data = raw.get("bytes")
            if data is None:
                return {}
            text = data.decode("utf-8", errors="replace")
        try:
            msg = json.loads(text)
        except json.JSONDecodeError:
            logger.debug("convai %s: dropped a non-JSON frame", self.conversation_id)
            return {}
        return msg if isinstance(msg, dict) else {}

    async def _dispatch(self, msg: dict) -> None:
        if "user_audio_chunk" in msg:
            await self._on_audio(msg.get("user_audio_chunk") or "")
            return
        kind = msg.get("type")
        if kind == "pong":
            self._unanswered_pings = 0
        elif kind == "user_activity":
            self._last_activity = time.monotonic()
        elif kind in (None, "conversation_initiation_client_data", "contextual_update",
                      "client_tool_result"):
            # Known-but-unhandled, or empty. Named so the log distinguishes
            # "this protocol has a feature we don't implement" from "we have no
            # idea what this client is saying".
            logger.debug("convai %s: ignoring %s", self.conversation_id, kind)
        else:
            logger.debug("convai %s: unknown message type %r",
                         self.conversation_id, kind)

    # -- ears ---------------------------------------------------------------
    async def _on_audio(self, b64: str) -> None:
        try:
            pcm = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            logger.debug("convai %s: dropped an undecodable audio chunk",
                         self.conversation_id)
            return
        self.recorder.heard(pcm)
        for event in self.gate.feed(pcm):
            if event.kind == SPEECH_START:
                await self._on_speech_start()
            elif event.kind == SPEECH_END and event.utterance is not None:
                await self._on_speech_end(event.utterance)
        if self._spec is not None and self.gate.speaking and not self.gate.in_hangover:
            # They were only pausing. Whatever was being written for the pause
            # is about a sentence that is still growing — drop it now rather
            # than let it look like an answer to whatever comes next.
            await self._cancel_speculation("caller resumed")
        self._maybe_partial()

    async def _on_speech_start(self) -> None:
        """They started talking. If the agent had the floor, they just took it."""
        self._last_activity = time.monotonic()
        # A speculation is cancelled SEPARATELY from the turn, and deliberately
        # not through _cancel_turn: that path sends an `interruption` event and
        # marks the transcript, and a speculation was never audible. There is
        # nothing for the client to un-hear.
        await self._cancel_speculation("new utterance")
        if self._turn is not None and not self._turn.done():
            await self._cancel_turn(interrupt=True)

    async def _on_speech_end(self, utterance: Utterance) -> None:
        self._last_activity = time.monotonic()
        self._begin_turn(self._answer(utterance))

    # -- incremental hearing (CONVAI_PARTIAL_DECODE) -------------------------
    def _maybe_partial(self) -> None:
        """Start a partial decode of the utterance so far, if one is due.

        Rate-limited, single-flighted, and silent about failure: a partial that
        does not happen costs nothing, which is what makes it safe to attempt
        from the audio path at all.
        """
        if not SETTINGS.convai_partial_decode:
            return
        if not self.gate.speaking:
            self._partials.clear()   # a new utterance agrees with nothing
            return
        if self._partial_task is not None and not self._partial_task.done():
            return
        if self.gate.voiced_ms < SETTINGS.convai_partial_min_ms:
            return
        now = time.monotonic()
        if now - self._partial_at < max(50, SETTINGS.convai_partial_interval_ms) / 1000.0:
            return
        pcm = self.gate.partial_pcm()
        if not pcm:
            return
        self._partial_at = now
        self._partial_task = asyncio.create_task(self._partial(pcm))
        self._partial_task.add_done_callback(self._speculative_task_finished)

    async def _partial(self, pcm: bytes) -> None:
        """Hear the utterance-so-far. Emits an interim transcript; records nothing."""
        heard = await asyncio.get_event_loop().run_in_executor(
            None, self._transcribe_partial, pcm)
        if heard is None:
            self._stats["partials_dropped"] += 1
            return
        self._stats["partials_run"] += 1
        text = heard.text.strip()
        if not text:
            self._stats["partials_empty"] += 1
            return
        if not self.gate.speaking:
            # The turn ended while this was decoding. The final decode owns the
            # utterance now, and a late partial must not race it.
            return
        self._partials.append(text)
        del self._partials[:-2]
        await self._send_interim(text)
        self._maybe_speculate()

    def _transcribe_partial(self, pcm: bytes) -> stt.Transcript | None:
        """Blocking; runs on the threadpool. Never raises — see ``_partial``."""
        try:
            return stt.transcribe_partial(
                pcm, rate=self.rate, language=self.agent.language or None,
                hotwords=" ".join(self.agent.keywords) or None)
        except stt.SttUnavailable:
            return None
        except Exception:  # noqa: BLE001 - a speculation is never worth a call
            logger.debug("convai %s: a partial decode failed",
                         self.conversation_id, exc_info=True)
            return None

    async def _send_interim(self, text: str) -> None:
        """What we think they are saying, so far.

        ``user_transcript`` with an explicit ``is_final: false``. The FINAL event
        is untouched and carries no such field, so a client that ignores the flag
        sees exactly the events it saw before this existed plus some earlier
        guesses — and a client that reads it can render live captions. Nothing
        here reaches ``history`` or the recorder; that is ``_answer``'s job and
        only for text a final decode produced.
        """
        self._stats["interims_sent"] += 1
        await self._send({"type": "user_transcript",
                          "user_transcription_event": {"user_transcript": text,
                                                       "is_final": False}})

    # -- speculative thinking (CONVAI_SPECULATE) ----------------------------
    def _maybe_speculate(self) -> None:
        """Start the brain early, on a prefix two decodes agree on, in hangover.

        The hangover condition is what keeps this cheap: the caller has already
        stopped making noise, so the prompt is nearly the whole utterance and the
        window before it is confirmed is exactly the window the brain needs.
        """
        if not (SETTINGS.convai_speculate and SETTINGS.convai_partial_decode):
            return
        if self._spec is not None or not self.gate.in_hangover:
            return
        prefix = agreed_prefix(self._partials)
        if len(prefix) < max(1, SETTINGS.convai_speculate_min_chars):
            return
        spec = _Speculation(prefix)
        self._spec = spec
        self._stats["speculations"] += 1
        spec.task = asyncio.create_task(self._speculate(spec))
        spec.task.add_done_callback(self._speculative_task_finished)
        logger.debug("convai %s: speculating on %r", self.conversation_id, prefix)

    async def _speculate(self, spec: _Speculation) -> None:
        """Write a reply nobody has asked for yet. Sends nothing, ever."""
        history = list(self.history) + [{"role": "user", "content": spec.prefix}]
        try:
            # The same brief the real turn would get, so a speculated reply can
            # direct itself too — a guess that came back without the directing
            # clause would be a DIFFERENT reply, and then speculation would be
            # observable in the record. It must not be.
            async for sentence in backend().reply(self._directing_agent(), history):
                spec.sentences.append(sentence)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - a guess may fail quietly
            # Deliberately NOT the fatal treatment _speak gives a DialogError:
            # the real turn will hit the same brain moments later and can close
            # the socket with a reason then, having actually needed an answer.
            logger.debug("convai %s: speculation failed (%s)",
                         self.conversation_id, exc)
            return
        spec.done = True

    async def _cancel_speculation(self, why: str) -> None:
        spec, self._spec = self._spec, None
        if spec is None:
            return
        self._stats["speculations_discarded"] += 1
        logger.debug("convai %s: dropped a speculation (%s)",
                     self.conversation_id, why)
        task = spec.task
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 - teardown
            pass

    def _take_speculation(self, final_text: str) -> list[str] | None:
        """The speculated reply if the confirmed transcript vindicates it.

        Consuming is unconditional — a speculation is used once or thrown away,
        never carried into the next turn, where its prefix would be a lie.
        """
        spec, self._spec = self._spec, None
        if spec is None:
            return None
        if spec.done and spec.sentences and continues(final_text, spec.prefix):
            self._stats["speculations_used"] += 1
            logger.info("convai %s: answered from a speculation on %r",
                        self.conversation_id, spec.prefix)
            return list(spec.sentences)
        self._stats["speculations_discarded"] += 1
        if spec.task is not None and not spec.task.done():
            spec.task.cancel()   # not awaited: nothing it holds is on the wire
        return None

    # -- openers (CONVAI_OPENERS) -------------------------------------------
    async def _send_opener(self) -> None:
        """A pre-rendered backchannel, on the wire while sentence one renders.

        Failure is invisible on purpose: an opener that cannot be synthesized
        just does not play, and the turn proceeds exactly as it would have.
        """
        phrases = opener_phrases()
        if not phrases:
            return
        phrase = phrases[self._turns % len(phrases)]
        try:
            entry, _ = await opener_cache().get_or_synthesize(
                (self.voice, self.is_piper, self.rate, phrase),
                lambda: self._render_opener(phrase))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - an opener is never the point
            logger.debug("convai %s: no opener (%s)", self.conversation_id, exc)
            return
        if not entry.pcm:
            return
        self._stats["openers_sent"] += 1
        await self._send_audio(entry.pcm)

    async def _render_opener(self, phrase: str) -> CachedPcm:
        return CachedPcm(pcm=await self._synthesize(phrase), sample_rate=self.rate)

    # -- turns --------------------------------------------------------------
    def _begin_turn(self, coro) -> None:
        """Run one turn, replacing whatever turn was in flight.

        Fire-and-forget by design: the read loop must keep consuming audio while
        the agent thinks, or the caller's microphone backs up and the next turn
        boundary lands late.
        """
        if self._turn is not None and not self._turn.done():
            self._turn.cancel()
        self._turn = asyncio.create_task(coro)
        # Nothing awaits this task on the happy path, so without a done-callback
        # a crash inside a turn would surface only as asyncio's "task exception
        # was never retrieved" at garbage-collection time, detached from the
        # conversation it killed.
        self._turn.add_done_callback(self._turn_finished)

    def _turn_finished(self, task: asyncio.Task) -> None:
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            logger.error("convai %s: turn failed", self.conversation_id, exc_info=exc)

    def _speculative_task_finished(self, task: asyncio.Task) -> None:
        """Same "never retrieved at GC time" guard as a turn, one level quieter.

        A speculation that dies has cost the conversation nothing, so it is a
        debug line rather than an error — but it is still retrieved, because an
        exception nobody looks at is how a broken speculation stays broken.
        """
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            logger.debug("convai %s: a speculative task failed",
                         self.conversation_id, exc_info=exc)

    async def _cancel_turn(self, *, interrupt: bool) -> None:
        turn, self._turn = self._turn, None
        if turn is None or turn.done():
            return
        turn.cancel()
        try:
            await turn
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 - teardown
            pass
        if interrupt and not self._closing:
            # The transcript keeps the agent's WHOLE reply — that is what it
            # said — but marks it, because only part of it was ever heard.
            if self.recorder.turns and self.recorder.turns[-1].role == "agent":
                self.recorder.turns[-1].interrupted = True
            await self._send({"type": "interruption",
                              "interruption_event": {"reason": "user_speech"}})

    async def _opening(self) -> None:
        """The agent's first message: spoken, not generated."""
        await self._speak(_aiter(dialog.split_sentences(self.agent.first_message)),
                          full_text=self.agent.first_message)

    async def _answer(self, utterance: Utterance) -> None:
        """Hear one utterance, then answer it."""
        t0 = time.monotonic()
        try:
            transcript = await asyncio.get_event_loop().run_in_executor(
                None, self._transcribe, utterance)
        except stt.SttUnavailable as exc:
            logger.error("convai %s: %s", self.conversation_id, exc)
            await self._close(_CLOSE_INTERNAL, "speech-to-text is unavailable")
            return
        except Exception:  # noqa: BLE001 - one bad utterance is not a dead call
            logger.exception("convai %s: transcription failed", self.conversation_id)
            return
        text = transcript.text.strip()
        if not text:
            # The gate heard a level, the transcriber heard no words: a door, a
            # cough, a false onset. Dropping it here is what keeps a level-based
            # gate honest — nothing empty ever becomes a turn. It is also why an
            # opener cannot play any earlier than this line: a backchannel over
            # a cough is a conversation talking to itself.
            logger.debug("convai %s: %.1fs of sound with no words in it",
                         self.conversation_id, utterance.seconds)
            await self._cancel_speculation("no words in the utterance")
            return
        logger.info("convai %s heard %.1fs in %.2fs: %s", self.conversation_id,
                    utterance.seconds, transcript.transcribe_s, text[:120])
        await self._send({"type": "user_transcript",
                          "user_transcription_event": {"user_transcript": text}})
        # THE turn is confirmed here: real words, from a final decode. Only now
        # may the floor be taken with a pre-rendered opener.
        if openers_enabled(self.agent.agent_id):
            await self._send_opener()
        self.recorder.turn(Turn(role="candidate", text=text,
                                at_s=round(utterance.started_at_s, 3),
                                audio_s=utterance.seconds,
                                transcribe_s=transcript.transcribe_s))
        # What language did we just hear? The ear reports one per utterance and
        # the tracker damps it (two consecutive utterances before it counts as a
        # switch), because acting on a single guess flaps the conversation.
        heard = dialog.language_tag(transcript.language_code)
        switched = self.languages.heard(heard, transcript.language_probability)
        if switched:
            logger.info("convai %s: the caller is now speaking %s",
                        self.conversation_id, switched)
            self.recorder.note(caller_language=switched)
        self._remember("user", text, language=heard)
        # A speculation is only ever an alternative SOURCE of the same sentences
        # — everything downstream (the text event, the transcript, history, the
        # audio) is the identical path, so a speculated turn and a thought-about
        # turn are indistinguishable in the record. Which is the point.
        speculated = self._take_speculation(text)
        sentences = (_aiter(speculated) if speculated is not None
                     else backend().reply(self._directing_agent(heard),
                                          list(self.history)))
        await self._speak(sentences, heard_at=t0)

    def _transcribe(self, utterance: Utterance) -> stt.Transcript:
        """Blocking; runs on the threadpool (see ``_answer``).

        Pinning the language is what makes a monolingual transcription accurate —
        and also what would stop the ear from ever REPORTING the switch this
        feature follows. So the pin is dropped exactly when the agent declared it
        would follow the caller, and kept in every other case.
        """
        pin = (None if len(self.agent.switch_languages()) > 1
               else (self.agent.language or None))
        return stt.transcribe_pcm(
            utterance.pcm, rate=self.rate, language=pin,
            hotwords=" ".join(self.agent.keywords) or None)

    def _directing_agent(self, heard: str | None = None) -> dialog.Agent:
        """The agent as the BRAIN sees it this turn.

        The stored prompt stays the operator's text; the directing clauses (which
        languages this call may switch into, which one the ear just heard, and the
        directive grammar itself) are assembled per turn from what the session
        knows right now.
        """
        return dataclasses.replace(self.agent, prompt=dialog.directing_prompt(
            self.agent, speaking=self.languages.language, heard=heard))

    async def _speak(self, sentences: AsyncIterator[dialog.TurnPart], *,
                     full_text: str | None = None,
                     heard_at: float | None = None) -> None:
        """Render a reply as it is written, then send the text and the audio.

        The ordering contract lives here: synthesis starts on sentence one while
        the model is still writing, but nothing is SENT until the whole reply is
        known and its ``agent_response`` has gone out (see the module docstring).
        """
        to_render: asyncio.Queue = asyncio.Queue()
        rendered: asyncio.Queue = asyncio.Queue()
        renderer = asyncio.create_task(self._render(to_render, rendered))
        parts: list[dialog.TurnPart] = []
        hang_up = False
        try:
            async for part in sentences:
                # One part is one sentence, so this is also where the mouth is
                # allowed to change: only ever at a boundary the words already had.
                part = self._direct(part)
                if part.end_call:
                    hang_up = True
                if not part.speakable():
                    continue   # a pure direction: nothing to say, nothing to render
                parts.append(part)
                to_render.put_nowait(part)
            to_render.put_nowait(None)  # the reply is complete

            reply = full_text if full_text is not None else " ".join(parts)
            if not reply.strip():
                return
            self._remember("assistant", reply)
            self._turns += 1
            await self._send({"type": "agent_response",
                              "agent_response_event": {"agent_response": reply}})
            spoken_turn = Turn(role="agent", text=reply, at_s=self.recorder.elapsed())
            self.recorder.turn(spoken_turn)

            first_audio = True
            while True:
                kind, payload = await rendered.get()
                if kind == "end":
                    break
                if kind == "error":
                    # The reply was spoken as text but could not be rendered.
                    # Logged and dropped rather than fatal: a client waiting for
                    # audio treats a text-only turn as a turn (that is what the
                    # protocol's no-audio grace period is for), so the
                    # conversation survives one failed synthesis.
                    logger.error("convai %s: synthesis failed mid-reply: %s",
                                 self.conversation_id, payload)
                    break
                await self._send_audio(payload)
                if first_audio:
                    if heard_at is not None:
                        spoken_turn.answer_s = round(time.monotonic() - heard_at, 3)
                        logger.info("convai %s answered in %.2fs",
                                    self.conversation_id, spoken_turn.answer_s)
                    first_audio = False
            if hang_up:
                # The brain wrote [end_call]. The closing words have already gone
                # out on the wire, so this is the goodbye LANDING rather than a
                # turn being cut off — hence 1000, and a reason the recording keeps.
                logger.info("convai %s: the agent ended the call",
                            self.conversation_id)
                await self._close(_CLOSE_NORMAL, "the agent ended the call")
        except dialog.DialogError as exc:
            # The brain is unreachable or refusing. That is not survivable the
            # way one bad sentence is, and a socket that stays open with a
            # silent agent is worse than one that says why it stopped.
            logger.error("convai %s: %s", self.conversation_id, exc)
            await self._close(_CLOSE_INTERNAL, str(exc)[:120])
        finally:
            renderer.cancel()
            self._last_activity = time.monotonic()

    async def _render(self, src: asyncio.Queue, dst: asyncio.Queue) -> None:
        """Synthesize sentences in order, posting each one's PCM as it lands.

        Runs alongside the reply stream, which is the whole latency argument:
        by the time the model has finished writing, sentence one has usually
        already been spoken into bytes.
        """
        while True:
            sentence = await src.get()
            if sentence is None:
                dst.put_nowait(("end", None))
                return
            try:
                pcm = await self._synthesize(sentence)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - reported, not swallowed
                dst.put_nowait(("error", exc))
                return
            dst.put_nowait(("audio", pcm))

    async def _send_audio(self, pcm: bytes) -> None:
        self.recorder.spoke(pcm)
        self._note_echo(pcm)
        step = max(1, int(self.rate * CHUNK_MS / 1000)) * 2
        for i in range(0, len(pcm), step):
            self._event_id += 1
            await self._send({
                "type": "audio",
                "audio_event": {
                    "audio_base_64": base64.b64encode(pcm[i:i + step]).decode("ascii"),
                    "event_id": self._event_id,
                },
            })

    def _note_echo(self, pcm: bytes) -> None:
        """Tell the gate what we just put on the wire (CONVAI_ECHO_SUPPRESSION).

        ``Recorder.spoke`` above is the reason this is possible at all: this
        session knows exactly which PCM it sent and when, which is a reference
        signal a hosted agent does not have about its own output. It is used for
        one narrow thing — not mistaking that audio, arriving back through an
        open microphone, for the caller taking the floor (see
        ``SpeechGate.expect_echo``). It is not echo cancellation, and a caller on
        headphones should leave it off.
        """
        if not SETTINGS.convai_echo_suppression or not pcm:
            return
        seconds = len(pcm) / 2 / max(1, self.rate)
        level_db = frame_db(np.frombuffer(pcm, dtype="<i2"))
        self.gate.expect_echo(level_db, seconds,
                              lag_ms=SETTINGS.convai_echo_lag_ms,
                              attenuation_db=SETTINGS.convai_echo_attenuation_db)

    def _publish_latency(self) -> None:
        """Put the turn-latency numbers where the recording already reports cost.

        ``answer_s`` per turn was always recorded; what was missing is the
        DISTRIBUTION and the context needed to compare two runs — which
        speculations were on, how many partials ran, how many guesses were used
        rather than thrown away. Written through ``Recorder.note`` (so it lands
        in meta.json next to the brain and model provenance) and logged, so the
        numbers exist even with recording off.
        """
        answers = [t.answer_s for t in self.recorder.turns
                   if t.role == "agent" and t.answer_s is not None]
        report = dict(self._stats,
                      flags=speculation_flags(),
                      turn_latency_s=_distribution(answers),
                      onsets_suppressed_as_echo=self.gate.suppressed_onsets,
                      # Process-wide, not this session's: the run lock these
                      # compete for is shared by every conversation on the box.
                      stt_partials_process=stt.partial_stats())
        self.recorder.note(latency=report)
        logger.info("convai %s latency: %s", self.conversation_id,
                    json.dumps(report, sort_keys=True))

    def _remember(self, role: str, content: str, language: str | None = None) -> None:
        # The language annotation is for the BRAIN only — it cannot follow the
        # caller into another language without being told which one that is.
        # dialog.OpenAiCompatBackend strips it before the wire (a server may
        # reject unknown message fields); ClaudeCliBackend renders it as
        # "Candidate [cs]:". It is not part of the recorded transcript.
        turn: dict = {"role": role, "content": content}
        if language:
            turn["language"] = language
        self.history.append(turn)
        if len(self.history) > _HISTORY_MAX:
            del self.history[:len(self.history) - _HISTORY_MAX]

    def _mouth(self, language: str | None = None) -> tuple[str, bool]:
        """Which voice speaks a part. One character, several engines.

        Resolved through the SAME rule as connect (``_resolve_voice``), so a
        mid-call switch can never reach a mouth the agents surface reported as
        absent. ``voice_id`` is cleared for a non-native language on purpose: the
        agent's explicit voice belongs to the language it was chosen for, and
        reusing it for another is the mispronunciation this refuses.
        """
        tag = dialog.language_tag(language) or self.languages.language
        if tag == dialog.language_tag(self.agent.language):
            return self.voice, self.is_piper
        found = self._mouths.get(tag)
        if found is None:
            found = _resolve_voice(dataclasses.replace(
                self.agent, language=tag, voice_id=""))
            self._mouths[tag] = found
        return found

    def _direct(self, part: dialog.TurnPart) -> dialog.TurnPart:
        """Honour one part's direction, or refuse it out loud.

        Called once per part, and a part is a sentence — which IS the mitigation
        for the audible seam: the mouth can only change where a sentence ended.
        """
        if not isinstance(part, dialog.TurnPart):
            part = dialog.TurnPart(str(part))   # a speculated line, or an opener
        wanted = part.language
        if not wanted or wanted == self.languages.language:
            # STAMPED, not left to default. Rendering runs concurrently with the
            # reply stream, so by the time sentence one reaches a mouth the
            # session may already have followed a [lang:cs] in sentence two —
            # reading the session's language at render time spoke the English
            # sentence with the Czech voice. The part decides its own mouth.
            return self._stamp(part, self.languages.language)
        if wanted in self._refused:
            # Already apologized for this one. The rest of the reply is dropped
            # rather than read with the wrong phonemes — or apologized for again.
            logger.info("convai %s: dropping an unspeakable %s sentence",
                        self.conversation_id, wanted)
            return dataclasses.replace(part, text="", language=None)
        problem = None
        try:
            voice, is_piper = self._mouth(wanted)
        except VoiceUnavailable as exc:
            problem = str(exc)
        else:
            if self.languages.directed(wanted) is not None:
                logger.info("convai %s: the mouth follows the brain into %s "
                            "(%s, %s)", self.conversation_id, wanted, voice,
                            "piper" if is_piper else "pocket-tts")
                self.recorder.note(spoken_language=wanted)
                return part
            problem = (f"agent '{self.agent.agent_id}' did not declare {wanted!r} "
                       "among its languages")
        logger.warning("convai %s: refusing a switch into %s (%s)",
                       self.conversation_id, wanted, problem)
        self._refused.add(wanted)
        # Spoken in the language we CAN still speak. ``emotion`` and ``end_call``
        # are preserved, so a refused switch cannot swallow a hang-up.
        return dataclasses.replace(part, text=dialog.switch_apology(
            self.languages.language, wanted), language=self.languages.language)

    def _stamp(self, part: dialog.TurnPart, language: str) -> dialog.TurnPart:
        """Fix the language a part will be SPOKEN in, whatever happens next."""
        if part.language == language:
            return part
        return dataclasses.replace(part, language=language)

    async def _synthesize(self, text: str) -> bytes:
        """One sentence, as PCM at the wire rate, from whichever mouth speaks it.

        The mouth is resolved PER PART rather than once per session: a part
        carrying a ``language`` was written to be spoken by that language's voice,
        and each engine's own native rate is resampled on its own path.
        """
        voice, is_piper = self._mouth(getattr(text, "language", None))
        if is_piper:
            return await asyncio.get_event_loop().run_in_executor(
                None, self._synthesize_piper, str(text), voice)
        engine = _engine_provider()
        if engine is None:
            raise RuntimeError("the synthesis engine is not running")
        job = engine.submit(voice_id=voice, text=str(text), overrides={})
        result = await asyncio.wait_for(asyncio.wrap_future(job.future),
                                        timeout=SETTINGS.request_timeout_s)
        return await asyncio.get_event_loop().run_in_executor(
            None, wav_to_pcm, result.wav_bytes, self.rate)

    def _synthesize_piper(self, text: str, voice: str | None = None) -> bytes:
        """Blocking; runs on the threadpool. Piper voices synthesize at their own
        rate (22.05 kHz for the medium set), so the resample happens here rather
        than in the protocol layer, which only ever sees the wire rate."""
        pcm, rate = piper.synthesize_pcm(voice or self.voice, text)
        if rate == self.rate or not pcm:
            return pcm
        samples = resample_pcm16(np.frombuffer(pcm, dtype="<i2"), rate, self.rate)
        return samples.tobytes()

    # -- plumbing -----------------------------------------------------------
    async def _send(self, message: dict) -> None:
        if self._closing:
            return
        async with self._send_lock:
            await self.ws.send_text(json.dumps(message))

    async def _close(self, code: int, reason: str) -> None:
        if self._closing:
            return
        self._ended = reason
        self._closing = True
        try:
            await self.ws.close(code=code, reason=reason[:120])
        except RuntimeError:
            pass  # already closed from the other side

    async def _watchdog(self) -> None:
        """Liveness and limits: ping, idle, and the whole-session ceiling.

        One loop for all three because they share a deadline check, and because
        a session that has to be ended should be ended by whichever limit
        noticed first.
        """
        interval = max(1.0, SETTINGS.convai_ping_interval_s)
        while not self._closing:
            await asyncio.sleep(interval)
            now = time.monotonic()
            if now - self._started > SETTINGS.convai_session_max_s:
                await self._close(_CLOSE_POLICY, "conversation length limit reached")
                return
            if now - self._last_activity > SETTINGS.convai_idle_timeout_s:
                await self._close(_CLOSE_POLICY, "conversation idle")
                return
            if self._unanswered_pings >= SETTINGS.convai_ping_max_missed:
                await self._close(_CLOSE_POLICY, "client stopped answering pings")
                return
            self._ping_id += 1
            self._unanswered_pings += 1
            await self._send({"type": "ping",
                              "ping_event": {"event_id": self._ping_id, "ping_ms": 0}})


async def _aiter(items: Iterable[str]) -> AsyncIterator[str]:
    """A fixed list of sentences, shaped like a streaming reply."""
    for item in items:
        yield item
