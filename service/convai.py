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
"""
from __future__ import annotations

import asyncio
import base64
import binascii
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
from service.config import SETTINGS
from service.engine import resample_pcm16
from service.recording import Recorder, Turn
from service.vad import SPEECH_END, SPEECH_START, SpeechGate, Utterance

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
    try:
        voice, is_piper = _resolve_voice(agent)
    except VoiceUnavailable as exc:
        return dict(described, voice_id=None, tts=None, speakable=False,
                    problem=str(exc))
    return dict(described, voice_id=voice,
                tts="piper" if is_piper else "pocket-tts", speakable=True)


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
        self.recorder = Recorder(self.conversation_id, self.rate)

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
                               brain=backend().describe(), stt=stt.describe_model())
            # Load the transcriber NOW, on a thread, rather than on the first
            # thing the caller says. It is a ~2 s load from a warm cache, and
            # paying it inside the first turn made the opening exchange of every
            # fresh conversation visibly slower than the rest of it. Here it
            # overlaps the agent's greeting — seconds the caller spends
            # listening — so by the time they answer, the ear is open.
            self._warming = asyncio.ensure_future(
                asyncio.get_event_loop().run_in_executor(None, _warm_ears))
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
            await self._cancel_turn(interrupt=False)
            self.recorder.note(turns=self._turns)
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

    async def _on_speech_start(self) -> None:
        """They started talking. If the agent had the floor, they just took it."""
        self._last_activity = time.monotonic()
        if self._turn is not None and not self._turn.done():
            await self._cancel_turn(interrupt=True)

    async def _on_speech_end(self, utterance: Utterance) -> None:
        self._last_activity = time.monotonic()
        self._begin_turn(self._answer(utterance))

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
            # gate honest — nothing empty ever becomes a turn.
            logger.debug("convai %s: %.1fs of sound with no words in it",
                         self.conversation_id, utterance.seconds)
            return
        logger.info("convai %s heard %.1fs in %.2fs: %s", self.conversation_id,
                    utterance.seconds, transcript.transcribe_s, text[:120])
        await self._send({"type": "user_transcript",
                          "user_transcription_event": {"user_transcript": text}})
        self.recorder.turn(Turn(role="candidate", text=text,
                                at_s=round(utterance.started_at_s, 3),
                                audio_s=utterance.seconds,
                                transcribe_s=transcript.transcribe_s))
        self._remember("user", text)
        await self._speak(backend().reply(self.agent, list(self.history)),
                          heard_at=t0)

    def _transcribe(self, utterance: Utterance) -> stt.Transcript:
        """Blocking; runs on the threadpool (see ``_answer``)."""
        return stt.transcribe_pcm(
            utterance.pcm, rate=self.rate, language=self.agent.language or None,
            hotwords=" ".join(self.agent.keywords) or None)

    async def _speak(self, sentences: AsyncIterator[str], *,
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
        parts: list[str] = []
        try:
            async for sentence in sentences:
                parts.append(sentence)
                to_render.put_nowait(sentence)
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

    def _remember(self, role: str, content: str) -> None:
        self.history.append({"role": role, "content": content})
        if len(self.history) > _HISTORY_MAX:
            del self.history[:len(self.history) - _HISTORY_MAX]

    async def _synthesize(self, text: str) -> bytes:
        """One sentence, as PCM at the wire rate, from whichever mouth speaks it."""
        if self.is_piper:
            return await asyncio.get_event_loop().run_in_executor(
                None, self._synthesize_piper, text)
        engine = _engine_provider()
        if engine is None:
            raise RuntimeError("the synthesis engine is not running")
        job = engine.submit(voice_id=self.voice, text=text, overrides={})
        result = await asyncio.wait_for(asyncio.wrap_future(job.future),
                                        timeout=SETTINGS.request_timeout_s)
        return await asyncio.get_event_loop().run_in_executor(
            None, wav_to_pcm, result.wav_bytes, self.rate)

    def _synthesize_piper(self, text: str) -> bytes:
        """Blocking; runs on the threadpool. Piper voices synthesize at their own
        rate (22.05 kHz for the medium set), so the resample happens here rather
        than in the protocol layer, which only ever sees the wire rate."""
        pcm, rate = piper.synthesize_pcm(self.voice, text)
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
