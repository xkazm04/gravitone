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
    # Which conversation_config_override fields a client may set.
    allow_overrides: list[str] = field(
        default_factory=lambda: ["prompt", "first_message", "language", "voice_id"])

    def voice(self) -> str:
        return self.voice_id or SETTINGS.default_voice


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
def split_sentences(text: str) -> list[str]:
    parts = [p.strip() for p in _SENTENCE_END.split((text or "").strip())]
    return [p for p in parts if p]


class _SentenceBuffer:
    """Turns a stream of model deltas into a stream of speakable sentences."""

    def __init__(self) -> None:
        self._buf = ""

    def push(self, delta: str) -> list[str]:
        self._buf += delta
        out: list[str] = []
        while True:
            match = _SENTENCE_END.search(self._buf)
            if match:
                out.append(self._buf[:match.start()].strip())
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
                out.append(self._buf[:cut].strip())
                self._buf = self._buf[cut:].lstrip()
                continue
            break
        return [s for s in out if s]

    def pending(self) -> bool:
        return bool(self._buf.strip())

    def drain(self) -> list[str]:
        rest, self._buf = self._buf.strip(), ""
        return [rest] if rest else []


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------
class DialogBackend:
    """Given the turns so far, stream what the agent says next."""

    name = "base"

    async def reply(self, agent: Agent, history: list[dict]) -> AsyncIterator[str]:
        raise NotImplementedError
        yield ""  # pragma: no cover - makes this an async generator for typing

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
    # cannot follow the speaker into another language, cannot react to what was
    # actually said, and cannot answer a question. Anything a test asserts about
    # adaptive behaviour needs the model-backed backend; this one is for the
    # assertions that require the interviewer to be identical every run.
    async def reply(self, agent: Agent, history: list[dict]) -> AsyncIterator[str]:
        spoken = sum(1 for m in history if m.get("role") == "assistant")
        # The first message is turn 0 and is sent by the session itself, so the
        # script picks up after however many turns the agent has already taken.
        idx = max(0, spoken - (1 if agent.first_message else 0))
        script = agent.script or [
            "Thank you, could you tell me more about that?",
            "That's everything I wanted to cover. Thanks for your time.",
        ]
        line = script[idx] if idx < len(script) else script[-1]
        for sentence in split_sentences(line):
            yield sentence


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

    async def reply(self, agent: Agent, history: list[dict]) -> AsyncIterator[str]:
        import httpx

        messages = [{"role": "system", "content": agent.prompt}] + history
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
        lines = [f"{'You' if m.get('role') == 'assistant' else 'Candidate'}: "
                 f"{m.get('content', '')}" for m in history]
        body = "\n".join(lines) if lines else "(the call has just connected)"
        return (f"This is a spoken interview in progress.\n\n{body}\n\n"
                "Say your next turn.")

    async def reply(self, agent: Agent, history: list[dict]) -> AsyncIterator[str]:
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

    async def _stream(self, proc, buf: "_SentenceBuffer") -> AsyncIterator[str]:
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
