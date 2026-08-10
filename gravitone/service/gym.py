"""The Conversation Gym - a recorded call, replayed as a deterministic test.

A spoken agent is the one kind of software nobody can test. Every run is
metered, every run is different, and none of them can be run again: the caller
was a human with a microphone, and they are not coming back to say the same
sentence with the same timing. So the category ships voice products verified by
one person listening once.

This module is the other option. `service/recording.py` already writes what a
replay needs - `user.wav` (exactly the bytes the caller's microphone sent) plus
a transcript carrying `audio_s`, `transcribe_s`, `answer_s` and `interrupted`
per turn - so a conversation that happened once can be streamed back into the
socket frame by frame, against the same agent, with the deterministic
`ScriptedBackend` for a brain. What comes out is a RUN ARTIFACT: the same
numbers the recording carries, produced again, and therefore comparable.

Three things live here:

  * `replay()` - the driver. Streams a recording's `user.wav` into
    `/v1/convai/conversation` as base64 `user_audio_chunk` frames (the loop
    `service/tests/test_convai_protocol.py` performs by hand with tones) and
    emits the run artifact.
  * `compare()` - two runs, scored against thresholds, exit-code friendly in
    the style of `service/certify.py`. Caller-transcript drift, answer/
    transcribe latency distributions, interruption differences, agent text.
  * suites - a directory of golden recordings plus a `suite.json` of thresholds
    and per-case expectations, so a downstream app runs its own conversations
    in its own CI.

**What a WER number here means.** The reference transcript was produced by the
same ASR that produces the new one. So a word error rate computed against it
measures DRIFT - "the ear changed" - and never truth. It is labelled that way
everywhere it appears, because the one thing worse than no accuracy number is a
fabricated one.

**Pacing.** `pace=1.0` streams the recording in real time, which is what a
latency claim needs. `pace=0.0` (the default) pushes frames as fast as the loop
can: the speech gate finds turn boundaries from SAMPLE counts and not from wall
clock, so the TURNS are identical either way and a structural test needs no
wall-clock patience at all.

What pacing does change is overlap. Blast the whole recording in and the
caller's second utterance arrives while the agent is still answering the first,
so the replay invents barge-ins the original call never had. Hence
``polite=True`` (the default): the driver pauses the feed while the agent has
the floor. Pausing costs nothing in gate terms - the gate has seen exactly the
same samples in exactly the same order - and it is what makes an unpaced replay
reproduce the recording's interruptions instead of manufacturing its own. Set
``polite=False`` (or use ``pace=1.0``, which reproduces the original timing) to
test barge-in behaviour on purpose. `compare()` refuses to score latency across
two different pacings rather than quietly averaging them.

**Why a suite run can flake on a busy box, and what was ruled out**
(measured 2026-08-10, so the next person does not re-derive it). The gate finds
turn boundaries from SAMPLE counts, so the audio side is deterministic - but
whether the SERVER calls a barge-in is not: `convai._on_speech_start` cancels
the agent's turn whenever the caller's next utterance starts while that turn is
still pending, which is a wall-clock race. The polite driver is what keeps that
race from firing, and its three deadlines (`POLITE_MAX_WAIT_S`,
`POLITE_EAR_WAIT_S`, `OPENING_GRACE_S`) are absolute constants sized for a fast
box. When one expires the driver resumes feeding ON TOP of the agent, which is
how a replay MANUFACTURES an interruption the recording never had - surfacing
as `interruptions_stable`, `agent_text_stable` or `turn_count_stable`, never as
a latency check. Measured: a timeout only RISKS the barge-in rather than
guaranteeing it (the feed resumes one frame per expired wait, so the caller's
next utterance may still land after the reply ended), which is the second half
of why the flake was intermittent. `gave_up` is the deterministic half, so it
is the half `compare()` scores.

Ruled out: `comparable_pacing` cannot flake - it compares `wire.pace`, the
float ARGUMENT passed to `replay()`, and both runs of a suite use the same one.
Also measured: 20 busy processes on 12 cores (a ~3x wall-clock stretch on the
suite) did NOT reproduce it - the deadlines still had roughly an order of
magnitude of headroom. So the fix is not to shorten the odds by weakening a
check: the driver now RECORDS what politeness cost (`run["politeness"]`:
longest waits, timeouts, `gave_up`), `compare()` leads with
`polite_replay_intact` so a starved box is named as a starved box instead of as
a changed agent, and a shared runner buys margin with `patience` (a multiplier
on all three deadlines, settable per call, per suite and per case). Nothing
about the product's own bar moved.

One default pace, everywhere: the library, `POST /v1/convai/replay` and
`python -m service.gym run` all default to `pace=0.0`, and real time is the
thing you ask for. They disagreed once - the CLI defaulted to 1.0 - and the
result was that a person who forgot `--pace 0` ran a different experiment from
the one the suite mints baselines with, then compared the two. `compare()`
catches that (`comparable_pacing`) rather than averaging it, but a default that
needs a check to catch it is a default in the wrong place.

**Baselines.** A suite baseline is a run artifact plus a `baseline` stamp
saying which run schema, which CHECK SET and which threshold NAMES it was
minted under. `run_suite` refuses to score a baseline whose stamp does not
match the running gym: a baseline recorded to answer a different question
cannot produce a verdict about this one, and "no comparison" reported as a pass
is the silent apples-to-oranges the stamp exists to prevent. `--update-baselines`
replaces a stale baseline and says so. Baselines are written through
`atomicio.atomic_write_text` behind a `file_lock`, for `recording.save_care`'s
reason: two CI shards (or a studio replay racing a CI job) are two processes,
and `os.replace` prevents a torn file, never a lost update.

CLI::

    python -m service.gym run <recording> [--agent ID] [--pace 1] [--out run.json]
    python -m service.gym compare before.json after.json
    python -m service.gym suite <dir> [--update-baselines]

`run` and `suite` drive the app in-process, so they need this service's own
dependencies importable (the same ones uvicorn needs). `compare` needs nothing
but the two artifacts - which is why nothing at the top of this module imports
the model stack.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import dataclasses
import json
import logging
import re
import threading
import time
import uuid
import wave
from pathlib import Path
from typing import Any, Iterable, Sequence
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from service import dialog, recording
from service.atomicio import atomic_write_text, file_lock
from service.config import SETTINGS

logger = logging.getLogger("gravitone.gym")

# Its OWN router: the gym is a test facility, not part of the conversation
# protocol, and the service that mounts it decides which scope it sits behind.
router = APIRouter(tags=["convai"])

RUN_SCHEMA = "gravitone-gym-run/1"
COMPARE_SCHEMA = "gravitone-gym-compare/1"
SUITE_SCHEMA = "gravitone-gym-suite/1"
# The stamp a suite puts on a baseline it writes. A baseline is a run artifact
# PLUS the question it was minted to answer, and the second half is what makes
# it safe to compare against months later.
BASELINE_SCHEMA = "gravitone-gym-baseline/1"
# The version of the CHECK SET - bump this whenever a check is added, removed
# or given different arithmetic. A baseline minted under an older check set was
# recorded to answer a different question, and scoring it silently is how a
# suite reports "pass" about checks that did not exist yet.
CHECK_SET = "gravitone-gym-checks/2"

# One frame is 100 ms of audio, which is what a browser client sends.
FRAME_MS = 100
# Trailing silence appended after the recording, so the gate can call the last
# turn. A recording ends when the caller hung up; a replay has to leave the
# hangover room the live call had.
TRAILING_SILENCE_MS = 1200
# How long the driver waits for the socket to go quiet before it decides the
# conversation is over. There is no "the agent is done" frame in the protocol,
# so silence on the wire is the only available signal.
QUIET_MS = 1200
# How quiet the wire has to be before a POLITE caller starts talking again. Wire
# silence alone is not enough (see _Wire.wait_for_floor): the reply also has to
# have PLAYED, which is the number this window sits on top of. It must also be
# LONGER than a synthesizer's between-sentence pause: a reply arrives sentence
# by sentence, and on a box rendering slower than the audio plays, the gap
# between two sentences of ONE reply is wire silence a 250 ms window mistook
# for the end of the turn. 1.2 s matches the trailing-silence hangover.
POLITE_QUIET_MS = 1200
# Longest a polite caller holds its tongue for one agent turn. Past this it
# talks anyway - an agent that never stops is a finding the run should record,
# not a driver that hangs.
POLITE_MAX_WAIT_S = 20.0
# After the caller finishes an utterance, how long a polite driver waits for
# the ear to confirm it heard words (a `user_transcript`). A real transcriber
# needs seconds; at pace 0 the next utterance would otherwise land while the
# answer to this one is still being formed, and the gate would read that as a
# barge-in the original call never had. A silence that produces no transcript
# within this window was a false onset (a door, a cough) and the feed resumes.
POLITE_EAR_WAIT_S = 10.0
# How long the driver waits for the OPENING to be announced before it starts
# feeding. See `_drive` for why it exists at all; it is a politeness deadline
# like the two above, so it scales with `patience` like them.
OPENING_GRACE_S = 3.0
# A caller frame counts as sound at this PCM16 amplitude - far above digital
# silence, far below speech. Only the polite driver reads it, and only to
# notice "I just finished saying something".
SPEECH_LEVEL = 500
# How many consecutive quiet frames after sound mean the utterance is over -
# the same order of magnitude as the gate's own hangover (~1 s at 100 ms frames).
QUIET_FRAMES_TO_YIELD = 10
# Whole-replay ceiling. A hung brain must fail the run, not the CI job.
DEADLINE_S = 180.0
# How many replay artifact directories `gym-runs` keeps. Symmetric with
# `recording.MAX_CONVERSATIONS`, and smaller on purpose: a replay's leftovers
# are the evidence for ONE CI job, not an archive, and a suite of a dozen cases
# run on every push fills a directory far faster than live calls do. The
# recorder's own `evict_oldest` does incidentally reach in here (a replay
# redirects `recording.SETTINGS` at this directory), but only at 200, only when
# the recording closed cleanly, and only as a side effect of somebody else's
# retention policy - which is not a policy this module can be said to have.
MAX_RUNS = 50

# The regression bar. Every number is a DELTA between two runs, never an
# absolute quality claim: this file cannot tell you whether the agent is good,
# only whether it changed.
THRESHOLDS: dict[str, float] = {
    # Caller-transcript drift, vs the earlier run. See the module docstring on
    # what this is and is not.
    "wer_drift_max": 0.05,
    # Structure: a replay of the same audio should find the same turns.
    "turn_count_delta_max": 0,
    "agent_text_changes_max": 0,
    "interruption_delta_max": 0,
    # Latency: allowed as a fraction of the earlier run's mean, plus an
    # absolute floor so a fast box's noise does not fail a run.
    "answer_s_regression_pct_max": 0.25,
    "answer_s_regression_abs_max_s": 0.20,
    "transcribe_s_regression_pct_max": 0.35,
    "transcribe_s_regression_abs_max_s": 0.20,
}

_WORD_RE = re.compile(r"[0-9a-z']+")

# One replay at a time per process. A replay rebinds the recording settings and
# drives the whole worker pool; two at once would record into each other's
# directory and measure each other's contention. The HTTP surface turns a busy
# lock into an honest refusal rather than a queue.
_REPLAY_LOCK = threading.Lock()


class GymError(RuntimeError):
    """A replay could not be run. Authored for whoever is holding the CLI: the
    message says which artifact was missing or which agent was unknown."""


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------
@dataclasses.dataclass(frozen=True)
class Source:
    """One golden conversation on disk: its audio, and what it heard.

    ``transcript`` is the REFERENCE for drift, and it is optional: a bare
    `user.wav` is a perfectly good fixture, it just cannot be scored against
    what the original run heard.
    """

    name: str
    user_wav: Path
    directory: Path | None = None
    transcript: dict | None = None
    meta: dict | None = None

    def candidate_texts(self) -> list[str]:
        turns = (self.transcript or {}).get("turns") or []
        return [str(t.get("text") or "") for t in turns
                if t.get("role") == "candidate"]

    def agent_id(self) -> str | None:
        found = (self.meta or {}).get("agent_id")
        return str(found) if found else None


def resolve_source(source: str | Path) -> Source:
    """A recording id, a recording directory, or a `user.wav` path -> Source.

    All three spellings exist because all three are how a person refers to a
    conversation: the id the service minted, the directory a suite checked in,
    or the one file they actually have.
    """
    path = Path(source)
    if path.is_file() and path.suffix.lower() == ".wav":
        return Source(name=path.stem, user_wav=path)
    if not path.is_dir():
        candidate = recording.recordings_dir() / str(source)
        if candidate.is_dir():
            path = candidate
        else:
            raise GymError(
                f"no recorded conversation '{source}'. Looked for a directory, a "
                f".wav, and an id under {recording.recordings_dir()}. Recordings "
                "are only written when CONVAI_RECORD=1.")
    wav = path / "user.wav"
    if not wav.is_file():
        raise GymError(f"{path} has no user.wav in it - a replay needs the "
                       "caller's audio, which is the half the agent reacted to.")
    return Source(name=path.name, user_wav=wav, directory=path,
                  transcript=_read_json(path / "transcript.json"),
                  meta=_read_json(path / "meta.json"))


def _read_json(path: Path) -> dict | None:
    try:
        found = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return found if isinstance(found, dict) else None


def read_pcm(path: Path, dst_rate: int) -> tuple[bytes, int]:
    """A mono PCM16 WAV as raw samples at the conversation's rate.

    Resampling is done here rather than refused, because a fixture recorded on
    a box configured for 8 kHz is still a valid conversation - and a replay that
    silently ran it at the wrong rate would report a turn structure that has
    nothing to do with the original.
    """
    with wave.open(str(path), "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise GymError(f"{path} is not mono 16-bit PCM ("
                           f"{w.getnchannels()} channel(s), "
                           f"{w.getsampwidth() * 8}-bit) - that is what the "
                           "conversation socket speaks.")
        rate = w.getframerate()
        pcm = w.readframes(w.getnframes())
    if rate != dst_rate:
        import numpy as np

        from service.engine import resample_pcm16

        pcm = resample_pcm16(np.frombuffer(pcm, dtype="<i2"),
                             rate, dst_rate).tobytes()
    return pcm, dst_rate


# ---------------------------------------------------------------------------
# The wire
# ---------------------------------------------------------------------------
class _Wire:
    """Reads the socket on its own thread while the driver talks into it.

    A real client does not send its whole microphone and then start listening,
    and the difference is load-bearing here: an interruption is only observable
    if somebody is reading during the agent's turn. Every message is stamped on
    arrival, so a run still has client-observed latencies even when the server
    side was not recording.
    """

    def __init__(self, ws: Any, deadline_s: float, rate: int) -> None:
        self.ws = ws
        self.rate = rate
        self.messages: list[dict] = []
        self.stamps: list[float] = []
        self.close_reason: str | None = None
        self.stopped = False
        self._deadline = time.monotonic() + deadline_s
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._read, name="gym-wire",
                                        daemon=True)
        self._last_at = time.monotonic()
        # "The agent has the floor": taken by an agent_response, and held until
        # the reply has both stopped arriving and finished PLAYING.
        self._floor = False
        self._floor_audio_s = 0.0
        self._floor_first_audio_at: float | None = None

    def start(self) -> None:
        self._thread.start()

    def _read(self) -> None:
        while not self.stopped and time.monotonic() < self._deadline:
            try:
                msg = self.ws.receive_json()
            except BaseException as exc:  # noqa: BLE001 - any end of the socket
                # The far end closed, or the test transport tore the streams
                # down when the driver left the `with` block. Either way this
                # thread's job is over; the reason is kept for the error path.
                self.close_reason = (getattr(exc, "reason", None)
                                     or f"{type(exc).__name__}: {exc}"[:200].strip())
                break
            with self._lock:
                self.messages.append(msg if isinstance(msg, dict) else {})
                self.stamps.append(time.monotonic())
                self._last_at = self.stamps[-1]
                self._note_floor(msg if isinstance(msg, dict) else {})
        self.stopped = True

    def _note_floor(self, msg: dict) -> None:
        """Track the agent's turn. Called under the lock, on the reader."""
        kind = msg.get("type")
        if kind == "agent_response":
            self._floor = True
            self._floor_audio_s = 0.0
            self._floor_first_audio_at = None
        elif kind == "audio" and self._floor:
            payload = (msg.get("audio_event") or {}).get("audio_base_64") or ""
            with contextlib.suppress(Exception):
                self._floor_audio_s += (
                    len(base64.b64decode(payload)) / 2 / max(1, self.rate))
            if self._floor_first_audio_at is None:
                self._floor_first_audio_at = self._last_at
        elif kind == "interruption":
            self._floor = False

    def stop(self) -> None:
        self.stopped = True

    def snapshot(self) -> list[tuple[dict, float]]:
        with self._lock:
            return list(zip(self.messages, self.stamps))

    def wait_for(self, kind: str, timeout_s: float) -> dict | None:
        """Block until a message of ``kind`` arrives (or the socket dies)."""
        until = time.monotonic() + timeout_s
        while time.monotonic() < until:
            for msg, _ in self.snapshot():
                if msg.get("type") == kind:
                    return msg
            if self.stopped:
                return None
            time.sleep(0.01)
        return None

    def wait_for_floor(self, quiet_s: float, timeout_s: float) -> bool:
        """Block while the agent's reply is still arriving OR still playing.

        Two conditions, because either one alone gets it wrong. Wire silence
        alone misreads a synthesizer slower than ``quiet_s`` as a caller who
        already waited - the socket goes quiet between two sentences of one
        reply. Playback time alone misreads a reply that has been rendered
        faster than it plays (which is the normal case: the whole point of
        `_send_audio` is that audio is transmitted far faster than it sounds).
        So: quiet on the wire, AND enough wall time since the first audio frame
        for everything received to have been heard - the same arithmetic
        `Recorder.spoke` uses to place the agent's track on the caller's clock.

        Returns True once the floor is free, False if ``timeout_s`` ran out
        first (an agent that never stops talking is a finding for the run, not a
        reason for the driver to hang).
        """
        until = time.monotonic() + timeout_s
        while time.monotonic() < until:
            if self.stopped:
                return True
            now = time.monotonic()
            with self._lock:
                if not self._floor:
                    return True
                if self._floor_first_audio_at is None:
                    # The reply is ANNOUNCED but its first audio has not
                    # arrived: the synthesizer is working. Treating this gap as
                    # "already played" is how a polite replay against a real
                    # model blasted the whole recording over the agent's
                    # opening — the fake engine's instant audio never shows
                    # the gap, which is why no test caught it. The floor is
                    # held; POLITE_MAX_WAIT_S still bounds a reply that never
                    # produces audio at all.
                    pass
                else:
                    idle = now - self._last_at
                    played = (now - self._floor_first_audio_at
                              >= self._floor_audio_s)
                    if idle >= quiet_s and played:
                        self._floor = False
                        return True
            time.sleep(0.02)
        return False

    def count(self, kind: str) -> int:
        with self._lock:
            return sum(1 for m in self.messages if m.get("type") == kind)

    def wait_for_count(self, kind: str, above: int, timeout_s: float) -> bool:
        """Block until a NEW message of ``kind`` arrives (count exceeds
        ``above``). Unlike wait_for, this cannot be satisfied by a message
        that was already there before the caller started waiting."""
        until = time.monotonic() + timeout_s
        while time.monotonic() < until:
            if self.count(kind) > above:
                return True
            if self.stopped:
                return False
            time.sleep(0.02)
        return False

    def wait_quiet(self, quiet_s: float, timeout_s: float) -> bool:
        """Block until the socket has said nothing for ``quiet_s``.

        Returns False when the whole timeout expired without a quiet window -
        i.e. the agent never stopped talking, which is a finding, not a crash.
        """
        until = time.monotonic() + timeout_s
        while time.monotonic() < until:
            if self.stopped:
                return True
            with self._lock:
                idle = time.monotonic() - self._last_at
            if idle >= quiet_s:
                return True
            time.sleep(0.02)
        return False


@contextlib.contextmanager
def _recording_into(directory: Path):
    """Force recording ON, into ``directory``, for the duration of a replay.

    The recorder is the only thing that knows what a turn COST (`transcribe_s`,
    `answer_s`), so a replay that did not record could only report what it saw
    from the outside. Recording is off by default for privacy reasons that do
    not apply to audio the operator handed us on purpose.
    """
    original = recording.SETTINGS
    recording.SETTINGS = dataclasses.replace(
        original, convai_record=True, convai_recordings_dir=str(directory))
    try:
        yield
    finally:
        recording.SETTINGS = original


# ---------------------------------------------------------------------------
# The driver
# ---------------------------------------------------------------------------
def replay(source: str | Path, *, agent_id: str | None = None,
           app: Any = None, pace: float = 0.0, frame_ms: int = FRAME_MS,
           trailing_silence_ms: int = TRAILING_SILENCE_MS,
           quiet_ms: int = QUIET_MS, deadline_s: float = DEADLINE_S,
           polite: bool = True, polite_quiet_ms: int = POLITE_QUIET_MS,
           patience: float = 1.0, override: dict | None = None,
           work_dir: str | Path | None = None) -> dict:
    """Stream one recorded conversation back through the socket.

    Returns the run artifact (see the module docstring). ``app`` defaults to
    this service's own FastAPI app, driven in process - there is no server to
    start and no port to pick, which is what makes this runnable in CI.
    """
    src = resolve_source(source)
    agent_id = agent_id or src.agent_id()
    if not agent_id:
        known = ", ".join(a.agent_id for a in dialog.list_agents()) or "none"
        raise GymError(
            f"replaying {src.name} needs an agent to replay it AGAINST, and its "
            f"meta.json does not name one. Pass agent_id (available: {known}).")
    if dialog.get_agent(agent_id) is None:
        known = ", ".join(a.agent_id for a in dialog.list_agents()) or "none"
        raise GymError(f"unknown agent '{agent_id}'. Available: {known}")

    rate = SETTINGS.convai_audio_rate
    pcm, rate = read_pcm(src.user_wav, rate)
    if trailing_silence_ms > 0:
        pcm += b"\x00\x00" * int(rate * trailing_silence_ms / 1000)

    run_id = uuid.uuid4().hex[:16]
    with _REPLAY_LOCK:
        runs_dir = Path(work_dir) if work_dir else _default_runs_dir()
        runs_dir.mkdir(parents=True, exist_ok=True)
        with _recording_into(runs_dir):
            wire, wall_s, conversation_id, manners = _drive(
                app or _default_app(), agent_id, pcm, rate,
                pace=pace, frame_ms=frame_ms, quiet_ms=quiet_ms,
                deadline_s=deadline_s, polite=polite,
                polite_quiet_ms=polite_quiet_ms, patience=patience,
                override=override)
        recorded = _read_json(runs_dir / conversation_id / "transcript.json") \
            if conversation_id else None
        # Inside the replay lock, and after the artifact has been read back:
        # eviction must never race the run that is still being written, and
        # this run's own directory is the newest, so it is never a candidate.
        evict_runs(runs_dir, MAX_RUNS)

    events, turns, timings_source = _turns(wire, recorded)
    artifact = {
        "schema": RUN_SCHEMA,
        "run_id": run_id,
        "agent_id": agent_id,
        "source_recording": str(src.directory or src.user_wav),
        "source_name": src.name,
        "conversation_id": conversation_id,
        "brain": _brain_description(),
        "wire": {
            "rate": rate,
            "frame_ms": frame_ms,
            "pace": round(float(pace), 3),
            "realtime": bool(pace),
            "polite": bool(polite),
            "audio_s": round(len(pcm) / 2 / rate, 3),
            "frames": events["frames_sent"],
            "trailing_silence_ms": trailing_silence_ms,
        },
        # Whether the driver was ABLE to be polite, and by how much margin. A
        # replay whose politeness ran out of patience talked over the agent,
        # and every structural number under it is then a fact about this box
        # rather than about the agent. See the module docstring's flake note.
        "politeness": manners,
        "timings_source": timings_source,
        "turns": turns,
        "totals": _totals(turns, wall_s, events),
        "drift_vs_source": _drift(src.candidate_texts(),
                                 [t["text"] for t in turns
                                  if t["role"] == "candidate"]),
        "events": {k: v for k, v in events.items() if k != "frames_sent"},
        # Why the socket stopped, when it stopped abnormally. A run whose wire
        # died mid-replay must say so, or its empty turn list reads as "the
        # agent said nothing" — the same lie an empty table tells.
        "wire_closed": wire.close_reason,
    }
    logger.info("gym run %s: %s turn(s), %d interruption(s), %.2fs wall",
                run_id, artifact["totals"]["turns"],
                artifact["totals"]["interruptions"], wall_s)
    return artifact


def _frame_has_sound(chunk: bytes) -> bool:
    """True when one PCM16 frame contains anything above digital silence.

    Deliberately crude - this is not a VAD, it is the one bit the polite
    driver needs ("did I just say something?"), computed without numpy so
    compare()-only installs never pay for it.
    """
    for j in range(0, len(chunk) - 1, 2):
        v = int.from_bytes(chunk[j:j + 2], "little", signed=True)
        if v >= SPEECH_LEVEL or v <= -SPEECH_LEVEL:
            return True
    return False


def _needs_lifespan(app: Any) -> bool:
    """True when this is the service's own app and nobody built its engine —
    the bare-process CLI/CI path. Under a live server (or a test that installed
    an engine) running the lifespan AGAIN would build a second model pool just
    to throw it away."""
    import service.app as appmod

    return app is appmod.app and appmod.ENGINE is None


def _default_app() -> Any:
    # Imported HERE and not at the top: `service.app` imports the whole model
    # stack, and `compare()` must work on a box that has none of it.
    import service.app as appmod

    return appmod.app


def _default_runs_dir() -> Path:
    return Path(SETTINGS.convai_recordings_dir).parent / "gym-runs"


def _brain_description() -> dict:
    """Which brain answered, recorded on the artifact.

    A run made against a language model is not comparable with a run made
    against the script, and the artifact has to say which it was or somebody
    will diff them.
    """
    try:
        from service import convai

        return dict(convai.backend().describe())
    except Exception as exc:  # noqa: BLE001 - a label must not fail a run
        return {"backend": "unknown", "problem": str(exc)[:120]}


def _drive(app: Any, agent_id: str, pcm: bytes, rate: int, *, pace: float,
           frame_ms: int, quiet_ms: int, deadline_s: float, polite: bool,
           polite_quiet_ms: int, patience: float,
           override: dict | None) -> tuple[_Wire, float, str | None, dict]:
    """Open the socket, stream the audio, wait for the room to go quiet.

    Also returns what politeness COST: the longest a wait actually blocked and
    how many waits ran out. Those numbers are the difference between "the agent
    changed" and "this box could not keep up", and until they were on the
    artifact the driver knew and nobody else did.
    """
    from fastapi.testclient import TestClient

    from service import convai

    client = TestClient(app)
    # The app's lifespan is what builds the engine. Under a live server it has
    # already run; a test installs its own engine. But the bare-process paths —
    # `python -m service.gym run` and `suite` in CI — import an app nobody has
    # started, and every synthesis then refuses with "the engine is not
    # running". Entering the TestClient runs startup/shutdown around the drive.
    lifespan = _needs_lifespan(app)
    url = (f"/v1/convai/conversation?agent_id={quote(agent_id)}"
           f"&token={convai.mint_ticket(agent_id)}")
    step = max(2, int(rate * frame_ms / 1000) * 2)
    frame_s = (step / 2) / rate
    started = time.monotonic()
    conversation_id: str | None = None
    frames = 0
    # Every politeness deadline scaled by one knob. They are wall-clock
    # constants sized for a fast box (see the module docstring); a shared CI
    # runner buys margin by raising `patience` rather than by anybody editing
    # the constants or loosening a product check.
    max_wait_s = POLITE_MAX_WAIT_S * patience
    ear_wait_s = POLITE_EAR_WAIT_S * patience
    manners: dict = {"polite": bool(polite), "patience": round(patience, 3),
                     "opening_announced": None, "floor_timeouts": 0,
                     "ear_timeouts": 0, "reply_timeouts": 0,
                     "longest_floor_wait_s": 0.0, "longest_ear_wait_s": 0.0,
                     "deadlines_s": {"floor": round(max_wait_s, 3),
                                     "ear": round(ear_wait_s, 3),
                                     "opening": round(
                                         OPENING_GRACE_S * patience, 3)},
                     "gave_up": False}

    def _timed(fn, *args) -> Any:
        """Run a wait, and remember how long it actually blocked."""
        at = time.monotonic()
        got = fn(*args)
        return got, time.monotonic() - at
    with (client if lifespan else contextlib.nullcontext()), \
            client.websocket_connect(url) as ws:
        wire = _Wire(ws, deadline_s, rate)
        wire.start()
        try:
            ws.send_json({"type": "conversation_initiation_client_data",
                          "conversation_config_override": {
                              "agent": override or {}}})
            meta = wire.wait_for("conversation_initiation_metadata", 15.0)
            if meta is None:
                raise GymError(
                    "the conversation never opened"
                    + (f" ({wire.close_reason})" if wire.close_reason else "")
                    + " - a replay needs the socket to accept the ticket and "
                      "announce the conversation.")
            conversation_id = ((meta.get("conversation_initiation_metadata_event")
                                or {}).get("conversation_id") or None)
            if polite:
                # Politeness must start BEFORE frame 1: at pace 0 the whole
                # recording fits in the socket before the opening is even
                # announced, and no per-frame floor check can pause frames
                # that are already gone. The opening is template text —
                # announced within milliseconds when there is one — so a case
                # that suppressed it (override first_message: "") spends this
                # one grace period and nothing else. Three seconds, not one:
                # on a live server the announcement shares an event loop with
                # real traffic, and a grace the announcement can lose to is a
                # barge-in generator (measured: 1.0s lost the race on this
                # box, exactly once per replay, always on the opening).
                manners["opening_announced"] = wire.wait_for(
                    "agent_response", OPENING_GRACE_S * patience) is not None
            spoke = False       # sound has gone out since the last yield
            quiet_run = 0       # consecutive quiet frames after that sound
            for i in range(0, len(pcm), step):
                if wire.stopped:
                    break   # the agent hung up mid-recording; stop feeding it
                if polite:
                    # Hold the frame while the agent still has the floor. This
                    # does NOT move the audio the gate sees - the samples are
                    # unchanged and still in order - it only stops an unpaced
                    # replay from talking over a reply the original caller
                    # politely waited out.
                    free, waited = _timed(wire.wait_for_floor,
                                          polite_quiet_ms / 1000.0, max_wait_s)
                    manners["longest_floor_wait_s"] = max(
                        manners["longest_floor_wait_s"], waited)
                    if not free:
                        # The agent still had the floor when patience ran out,
                        # so the next frames go out ON TOP of it. That is a
                        # manufactured barge-in, and it is recorded as one.
                        manners["floor_timeouts"] += 1
                chunk = pcm[i:i + step]
                ws.send_json({"user_audio_chunk": base64.b64encode(
                    chunk).decode("ascii")})
                frames += 1
                if pace:
                    time.sleep(frame_s * pace)
                if not polite:
                    continue
                # Politeness has a second half. The floor wait above yields
                # while the agent SPEAKS; this yields after the caller speaks —
                # because the answer to an utterance starts with silence
                # (transcription, then the brain), and at pace 0 the next
                # utterance would land inside that silence and be scored as a
                # barge-in the recording never contained. The samples are
                # still byte-identical and in order; only their wall-clock
                # arrival moves, exactly like the floor wait.
                if _frame_has_sound(chunk):
                    spoke, quiet_run = True, 0
                elif spoke:
                    quiet_run += 1
                    if quiet_run >= QUIET_FRAMES_TO_YIELD:
                        spoke, quiet_run = False, 0
                        heard = wire.count("user_transcript")
                        answered = wire.count("agent_response")
                        confirmed, waited = _timed(
                            wire.wait_for_count, "user_transcript", heard,
                            ear_wait_s)
                        manners["longest_ear_wait_s"] = max(
                            manners["longest_ear_wait_s"], waited)
                        if confirmed:
                            # Words confirmed; now the brain owes a reply.
                            if not wire.wait_for_count("agent_response",
                                                       answered, max_wait_s):
                                manners["reply_timeouts"] += 1
                        elif not wire.stopped:
                            # Either a false onset (a door, a cough - fine, and
                            # the feed resumes) or an ear too slow to answer
                            # within the deadline. The driver cannot tell them
                            # apart, so it counts the ambiguity rather than
                            # assuming the innocent one: a run with ear
                            # timeouts in it is a run whose turn boundaries may
                            # have been placed by this box's scheduler.
                            manners["ear_timeouts"] += 1
            wire.wait_quiet(quiet_ms / 1000.0,
                            max(1.0, deadline_s - (time.monotonic() - started)))
        finally:
            wire.stop()
    wire.frames_sent = frames  # type: ignore[attr-defined]
    for key in ("longest_floor_wait_s", "longest_ear_wait_s"):
        manners[key] = round(manners[key], 3)
    # `ear_timeouts` is deliberately NOT part of this: a silence that produced
    # no transcript is equally a false onset (a door, a cough), which is normal
    # in a real recording. A floor or reply timeout has no innocent reading -
    # the agent had the floor, or owed a reply, and the driver stopped waiting.
    manners["gave_up"] = bool(manners["floor_timeouts"]
                              or manners["reply_timeouts"])
    return wire, round(time.monotonic() - started, 3), conversation_id, manners


# ---------------------------------------------------------------------------
# Artifact assembly
# ---------------------------------------------------------------------------
def _turns(wire: _Wire, recorded: dict | None) -> tuple[dict, list[dict], str]:
    """(wire event counts, turns, which source the timings came from).

    The recorder is preferred because it is the only half that knows what a
    turn cost. The wire is the fallback AND the cross-check: its event counts go
    on the artifact either way, so a run whose recording failed still reports
    what the client observed.
    """
    events = {"user_transcript": 0, "agent_response": 0, "interruption": 0,
              "audio": 0, "ping": 0, "frames_sent": getattr(wire, "frames_sent", 0)}
    observed: list[dict] = []
    for msg, at in wire.snapshot():
        kind = msg.get("type")
        if kind in events:
            events[kind] += 1
        if kind == "user_transcript":
            observed.append({"role": "candidate", "at": at, "text": str(
                (msg.get("user_transcription_event") or {}).get(
                    "user_transcript") or "")})
        elif kind == "agent_response":
            observed.append({"role": "agent", "at": at, "text": str(
                (msg.get("agent_response_event") or {}).get(
                    "agent_response") or "")})
        elif kind == "audio":
            if observed and observed[-1]["role"] == "agent":
                observed[-1].setdefault("first_audio_at", at)
        elif kind == "interruption":
            if observed and observed[-1]["role"] == "agent":
                observed[-1]["interrupted"] = True

    turns = (_turns_from_recording(recorded) if recorded
             else _turns_from_wire(observed))
    return events, turns, "recorder" if recorded else "wire"


def _turns_from_recording(recorded: dict) -> list[dict]:
    out: list[dict] = []
    for i, turn in enumerate(recorded.get("turns") or []):
        entry = {
            "i": i,
            "role": str(turn.get("role") or ""),
            "text": str(turn.get("text") or ""),
            "audio_s": turn.get("audio_s"),
            "transcribe_s": turn.get("transcribe_s"),
            "answer_s": turn.get("answer_s"),
            "interrupted": bool(turn.get("interrupted")),
        }
        # Mouth telemetry travels with the turn when the recorder captured it
        # — a replay's internal-lens evidence is the same shape as a live
        # session's. Absent stays absent.
        if turn.get("spoke") is not None:
            entry["spoke"] = turn["spoke"]
        out.append(entry)
    return out


def _turns_from_wire(observed: list[dict]) -> list[dict]:
    """Turns as the CLIENT saw them, when there is no recording to read.

    ``answer_s`` here is measured from the transcript event to the first audio
    frame of the reply - a client-side number, which is why the artifact says
    ``timings_source: wire``. ``audio_s``/``transcribe_s`` are simply absent:
    only the server knows them, and inventing them would be worse than a null.
    """
    out: list[dict] = []
    heard_at: float | None = None
    for i, turn in enumerate(observed):
        entry = {"i": i, "role": turn["role"], "text": turn["text"],
                 "audio_s": None, "transcribe_s": None, "answer_s": None,
                 "interrupted": bool(turn.get("interrupted"))}
        if turn["role"] == "candidate":
            heard_at = turn["at"]
        elif heard_at is not None and turn.get("first_audio_at") is not None:
            entry["answer_s"] = round(turn["first_audio_at"] - heard_at, 3)
            heard_at = None
        out.append(entry)
    return out


def dist(values: Iterable[float | None]) -> dict:
    """A distribution as this file reports one: n, mean, p50, max.

    Absent is absent - a turn with no `answer_s` is not a zero, and averaging
    it as one is how a latency report starts lying.
    """
    got = sorted(float(v) for v in values if v is not None)
    if not got:
        return {"n": 0, "mean": None, "p50": None, "max": None}
    mid = len(got) // 2
    p50 = got[mid] if len(got) % 2 else (got[mid - 1] + got[mid]) / 2
    return {"n": len(got), "mean": round(sum(got) / len(got), 4),
            "p50": round(p50, 4), "max": round(got[-1], 4)}


def _totals(turns: list[dict], wall_s: float, events: dict) -> dict:
    return {
        "turns": len(turns),
        "candidate_turns": sum(1 for t in turns if t["role"] == "candidate"),
        "agent_turns": sum(1 for t in turns if t["role"] == "agent"),
        "interruptions": sum(1 for t in turns if t["interrupted"]),
        "answer_s": dist(t["answer_s"] for t in turns),
        "transcribe_s": dist(t["transcribe_s"] for t in turns),
        "audio_s_total": round(sum(t["audio_s"] or 0.0 for t in turns), 3),
        "wall_s": wall_s,
        "audio_events": events.get("audio", 0),
    }


# ---------------------------------------------------------------------------
# Drift (word error rate against an ASR reference)
# ---------------------------------------------------------------------------
def words(text: str) -> list[str]:
    return _WORD_RE.findall((text or "").lower())


def edit_distance(ref: Sequence[str], hyp: Sequence[str]) -> int:
    """Token-level Levenshtein - substitutions, insertions, deletions."""
    if not ref:
        return len(hyp)
    previous = list(range(len(ref) + 1))
    for j, h in enumerate(hyp, start=1):
        current = [j]
        for i, r in enumerate(ref, start=1):
            current.append(min(previous[i] + 1,          # deletion from ref
                               current[i - 1] + 1,       # insertion
                               previous[i - 1] + (r != h)))
        previous = current
    return previous[-1]


def word_error_rate(reference: Sequence[str], hypothesis: Sequence[str]) -> dict:
    """Corpus-level WER over two lists of turn texts.

    Corpus-level (total errors over total reference words), not the mean of
    per-turn rates: a two-word turn and a forty-word turn are not the same
    amount of evidence. Turns present in one list and not the other are counted
    as whole-turn errors rather than skipped.
    """
    errors = 0
    length = 0
    for i in range(max(len(reference), len(hypothesis))):
        ref = words(reference[i]) if i < len(reference) else []
        hyp = words(hypothesis[i]) if i < len(hypothesis) else []
        errors += edit_distance(ref, hyp)
        length += len(ref)
    if not length:
        return {"wer": 0.0 if not errors else 1.0, "errors": errors,
                "reference_words": 0, "turns": max(len(reference), len(hypothesis))}
    return {"wer": round(errors / length, 4), "errors": errors,
            "reference_words": length,
            "turns": max(len(reference), len(hypothesis))}


_DRIFT_NOTE = ("word error rate against an ASR-produced reference: this "
               "measures DRIFT in what the ear hears, not accuracy against "
               "ground truth")


def _drift(reference: list[str], hypothesis: list[str]) -> dict:
    if not reference:
        return {"available": False,
                "why": "the source recording has no transcript to compare with",
                "note": _DRIFT_NOTE}
    return dict(word_error_rate(reference, hypothesis), available=True,
                note=_DRIFT_NOTE)


# ---------------------------------------------------------------------------
# compare()
# ---------------------------------------------------------------------------
def _texts(run: dict, role: str) -> list[str]:
    return [str(t.get("text") or "") for t in (run.get("turns") or [])
            if t.get("role") == role]


def _check(name: str, want: str, got: Any, passed: bool) -> dict:
    return {"check": name, "want": want, "got": got, "pass": bool(passed)}


def compare(run_a: dict, run_b: dict, thresholds: dict | None = None) -> dict:
    """Score run B against run A. A is the baseline; B is the change.

    Exit-code friendly in the shape `service/certify.py` established: a list of
    named checks each carrying want/got/pass, and one verdict over all of them.
    Every check is a comparison between the two runs - this cannot tell you the
    agent is good, only that it is (or is not) the agent you had before.
    """
    limits = dict(THRESHOLDS, **(thresholds or {}))
    turns_a, turns_b = run_a.get("turns") or [], run_b.get("turns") or []
    drift = word_error_rate(_texts(run_a, "candidate"), _texts(run_b, "candidate"))

    agent_a, agent_b = _texts(run_a, "agent"), _texts(run_b, "agent")
    changed = [{"i": i,
                "a": agent_a[i] if i < len(agent_a) else None,
                "b": agent_b[i] if i < len(agent_b) else None}
               for i in range(max(len(agent_a), len(agent_b)))
               if (agent_a[i] if i < len(agent_a) else None)
               != (agent_b[i] if i < len(agent_b) else None)]

    int_a = sum(1 for t in turns_a if t.get("interrupted"))
    int_b = sum(1 for t in turns_b if t.get("interrupted"))
    turn_delta = len(turns_b) - len(turns_a)

    # Pacing AND politeness: both decide how much of the caller lands on top of
    # the agent, so a run that differs in either is a different experiment.
    pace_a = _pacing(run_a)
    pace_b = _pacing(run_b)
    comparable = pace_a == pace_b

    checks = [
        # FIRST of all, because it is the check that says the other checks were
        # computed over the right kind of document. `compare_runs` (the HTTP
        # surface) rejects a wrong-schema artifact with a 422, but the CLI and
        # the suite call compare() directly - and those are the two paths a CI
        # job actually uses. Without this, a baseline written by an older gym
        # (or a comparison handed in where a run belongs) scores two empty turn
        # lists against each other and reports a confident "pass" about
        # nothing. It is a failing CHECK rather than an exception because the
        # verdict is the product here: a suite must be able to name which case
        # holds an unreadable baseline and keep going.
        _check("comparable_schema",
               f"both runs are {RUN_SCHEMA} artifacts",
               f"a={run_a.get('schema')!r} b={run_b.get('schema')!r}",
               run_a.get("schema") == RUN_SCHEMA
               and run_b.get("schema") == RUN_SCHEMA),
        # THEN, because every latency number under it depends on it: two runs
        # streamed at different pacings are two different experiments, and a
        # delta between them is arithmetic rather than evidence.
        _check("comparable_pacing", "the same wire pace in both runs",
               f"a=pace {pace_a[0]}/polite {pace_a[1]} "
               f"b=pace {pace_b[0]}/polite {pace_b[1]}", comparable),
        # BEFORE the structural checks, because it is the one that says which
        # of them to believe. A polite replay that ran out of patience fed the
        # caller over the agent, and the turn count / interruption / agent text
        # deltas under it are then measurements of THIS BOX, not of the agent.
        # Named separately so the report leads with "the driver could not stay
        # polite" instead of "the agent grew an interruption".
        _check("polite_replay_intact",
               "neither run ran out of patience waiting for the agent",
               f"a={_gave_up(run_a)} b={_gave_up(run_b)}",
               not _gave_up(run_a) and not _gave_up(run_b)),
        _check("turn_count_stable",
               f"|delta| <= {limits['turn_count_delta_max']}", turn_delta,
               abs(turn_delta) <= limits["turn_count_delta_max"]),
        _check("caller_transcript_drift", f"WER <= {limits['wer_drift_max']}",
               drift["wer"], drift["wer"] <= limits["wer_drift_max"]),
        _check("agent_text_stable",
               f"<= {limits['agent_text_changes_max']} changed turn(s)",
               len(changed), len(changed) <= limits["agent_text_changes_max"]),
        _check("interruptions_stable",
               f"|delta| <= {limits['interruption_delta_max']}", int_b - int_a,
               abs(int_b - int_a) <= limits["interruption_delta_max"]),
    ]
    latency = {}
    for field, pct_key, abs_key in (
            ("answer_s", "answer_s_regression_pct_max",
             "answer_s_regression_abs_max_s"),
            ("transcribe_s", "transcribe_s_regression_pct_max",
             "transcribe_s_regression_abs_max_s")):
        entry = _latency_delta(run_a, run_b, field)
        latency[field] = entry
        checks.append(_latency_check(field, entry, limits[pct_key],
                                     limits[abs_key], comparable))

    result = {
        "schema": COMPARE_SCHEMA,
        "runs": {
            "a": _run_ref(run_a),
            "b": _run_ref(run_b),
        },
        "wer_drift": dict(drift, note=_DRIFT_NOTE),
        "latency": latency,
        "interruptions": {"a": int_a, "b": int_b, "delta": int_b - int_a},
        "agent_text": {"changed": changed,
                       "unchanged": max(len(agent_a), len(agent_b)) - len(changed)},
        "turn_count": {"a": len(turns_a), "b": len(turns_b), "delta": turn_delta},
        "thresholds": limits,
        "checks": checks,
        "verdict": "pass" if all(c["pass"] for c in checks) else "fail",
    }
    return result


def _gave_up(run: dict) -> bool:
    """Did this run's polite driver stop waiting for the agent?

    Absent means no - artifacts written before the driver counted this carry
    no `politeness` block, and treating "we did not measure it" as "it
    happened" would fail every comparison against an older run.
    """
    return bool((run.get("politeness") or {}).get("gave_up"))


def _pacing(run: dict) -> tuple[Any, Any]:
    wire = run.get("wire") or {}
    return wire.get("pace"), wire.get("polite")


def _run_ref(run: dict) -> dict:
    return {"run_id": run.get("run_id"), "agent_id": run.get("agent_id"),
            "source_name": run.get("source_name"),
            "timings_source": run.get("timings_source"),
            "brain": (run.get("brain") or {}).get("backend"),
            "pace": (run.get("wire") or {}).get("pace"),
            "polite": (run.get("wire") or {}).get("polite")}


def _latency_delta(run_a: dict, run_b: dict, field: str) -> dict:
    a = ((run_a.get("totals") or {}).get(field) or {})
    b = ((run_b.get("totals") or {}).get(field) or {})
    entry: dict = {"a": a, "b": b, "delta_mean_s": None, "delta_pct": None}
    if a.get("mean") is None or b.get("mean") is None:
        entry["why"] = ("one of the runs measured no " + field
                        + " - nothing to compare")
        return entry
    entry["delta_mean_s"] = round(b["mean"] - a["mean"], 4)
    if a["mean"] > 0:
        entry["delta_pct"] = round((b["mean"] - a["mean"]) / a["mean"], 4)
    return entry


def _latency_check(field: str, entry: dict, pct_max: float, abs_max: float,
                   comparable: bool) -> dict:
    name = f"{field}_no_regression"
    want = f"mean within +{pct_max:.0%} or +{abs_max}s of the baseline"
    if not comparable:
        # Reported, never scored: the pacing check already failed, and failing
        # this one too would say the agent got slower when what changed was the
        # experiment.
        return _check(name, want, "not scored (pacing differs)", True)
    if entry["delta_mean_s"] is None:
        return _check(name, want, entry.get("why", "no measurement"), True)
    allowed = max(abs_max, (entry["a"]["mean"] or 0.0) * pct_max)
    return _check(name, want,
                  f"{entry['delta_mean_s']:+.4f}s (allowed +{allowed:.4f}s)",
                  entry["delta_mean_s"] <= allowed)


def exit_code(result: dict) -> int:
    """0 when it passed, 2 when it did not - `certify.py`'s convention."""
    return 0 if result.get("verdict") == "pass" else 2


# ---------------------------------------------------------------------------
# Suites
# ---------------------------------------------------------------------------
def load_suite(directory: str | Path) -> dict:
    """A suite directory's `suite.json`, validated enough to fail usefully."""
    root = Path(directory)
    path = root / "suite.json"
    suite = _read_json(path)
    if suite is None:
        raise GymError(f"{path} is missing or not readable JSON. A suite is a "
                       "directory of golden recordings plus a suite.json of "
                       "thresholds and expectations.")
    cases = suite.get("cases")
    if not isinstance(cases, list) or not cases:
        raise GymError(f"{path} has no cases in it - a suite with no "
                       "conversations in it would pass forever.")
    return dict(suite, root=str(root))


def _case_expectations(run: dict, expect: dict | None) -> list[dict]:
    """Per-case assertions - the things a suite claims about EVERY run.

    Deliberately small and textual. These are the claims that do not need a
    baseline to be worth checking: that the opening still discloses what it has
    to, that turns stayed short enough to listen to, that the conversation
    happened at all.
    """
    checks: list[dict] = []
    if not expect:
        return checks
    agent_texts = _texts(run, "agent")
    first = agent_texts[0] if agent_texts else ""

    for needle in expect.get("first_agent_turn_contains") or []:
        checks.append(_check("first_agent_turn_contains",
                             f"the opening mentions {needle!r}",
                             (first[:80] + "...") if len(first) > 80 else first,
                             str(needle).lower() in first.lower()))
    for needle in expect.get("no_turn_contains") or []:
        offenders = [t for t in agent_texts if str(needle).lower() in t.lower()]
        checks.append(_check("no_turn_contains",
                             f"no agent turn contains {needle!r}",
                             len(offenders), not offenders))
    limit = expect.get("max_sentences_per_agent_turn")
    if limit is not None:
        worst = max((len(dialog.split_sentences(t)) for t in agent_texts),
                    default=0)
        checks.append(_check("max_sentences_per_agent_turn",
                             f"<= {limit} sentence(s) per turn", worst,
                             worst <= int(limit)))
    minimum = expect.get("min_turns")
    if minimum is not None:
        got = (run.get("totals") or {}).get("turns", 0)
        checks.append(_check("min_turns", f">= {minimum} turn(s)", got,
                             got >= int(minimum)))
    maximum = expect.get("max_interruptions")
    if maximum is not None:
        got = (run.get("totals") or {}).get("interruptions", 0)
        checks.append(_check("max_interruptions", f"<= {maximum}", got,
                             got <= int(maximum)))
    drift_max = expect.get("max_drift_vs_source")
    if drift_max is not None:
        drift = run.get("drift_vs_source") or {}
        if drift.get("available"):
            checks.append(_check("max_drift_vs_source",
                                 f"WER <= {drift_max} vs the source transcript "
                                 "(drift, not truth)", drift.get("wer"),
                                 float(drift.get("wer", 1.0)) <= float(drift_max)))
        else:
            checks.append(_check("max_drift_vs_source", f"WER <= {drift_max}",
                                 "no source transcript to compare with", False))
    return checks


def baseline_stamp(thresholds: dict) -> dict:
    """What a baseline has to remember about the question it was minted for.

    A run artifact says what happened. A BASELINE additionally has to say what
    it was recorded to be compared against, or the next suite silently scores
    it under arithmetic that did not exist when it was written.
    """
    return {
        "schema": BASELINE_SCHEMA,
        "run_schema": RUN_SCHEMA,
        "check_set": CHECK_SET,
        "thresholds": sorted(thresholds),
        "written_at": round(time.time(), 3),
    }


def baseline_staleness(baseline: dict, thresholds: dict) -> str | None:
    """Why this baseline cannot be compared against today's suite, or None.

    Three ways to be stale, and each one produces a verdict that LOOKS like
    evidence: a run artifact of another schema, a stamp from an older check
    set, or a threshold NAME set that no longer matches (a check was added, so
    the baseline was never scored on it). Threshold VALUES are deliberately not
    compared - retuning a bar in `suite.json` is a decision about the current
    run, not a reason to throw away the record of the old one.
    """
    if baseline.get("schema") != RUN_SCHEMA:
        return (f"it is not a {RUN_SCHEMA} artifact "
                f"(schema: {baseline.get('schema')!r})")
    stamp = baseline.get("baseline")
    if not isinstance(stamp, dict):
        return ("it carries no baseline stamp, so which check set it was "
                "minted under is unknown")
    if stamp.get("check_set") != CHECK_SET:
        return (f"it was minted under check set {stamp.get('check_set')!r}, "
                f"and this gym scores {CHECK_SET}")
    if list(stamp.get("thresholds") or []) != sorted(thresholds):
        missing = sorted(set(thresholds) - set(stamp.get("thresholds") or []))
        return ("its threshold set differs from this suite's"
                + (f" (never scored on: {', '.join(missing)})" if missing else ""))
    return None


def write_baseline(path: Path, run: dict, thresholds: dict) -> dict:
    """Write a run as a baseline: stamped, atomic, and cross-process exclusive.

    The `file_lock` and not merely the atomic write, for `recording.save_care`'s
    reason: this service ships as N single-worker processes, and two suite
    runners (two CI shards, or a studio replay racing a CI job) doing
    read-baseline-then-write-baseline must serialize on the whole sequence -
    `os.replace` prevents a torn file, never a lost update.
    """
    payload = dict(run, baseline=baseline_stamp(thresholds))
    path.parent.mkdir(parents=True, exist_ok=True)
    with file_lock(path.parent / f".{path.name}.lock"):
        atomic_write_text(path, json.dumps(payload, indent=2))
    return payload


def evict_runs(runs_dir: Path, limit: int = MAX_RUNS) -> int:
    """Drop the oldest replay artifacts past ``limit``. Returns how many went.

    Deliberately the same shape as `recording.evict_oldest` - oldest by mtime,
    one directory of files, an OSError on a directory somebody still holds open
    is a debug line and not a failed run. It is a SEPARATE pass because the two
    directories answer to different policies: recordings are a privacy-gated
    archive of real callers, gym runs are CI scratch.
    """
    if not runs_dir.is_dir():
        return 0
    try:
        dirs = sorted((d for d in runs_dir.iterdir() if d.is_dir()),
                      key=lambda d: d.stat().st_mtime)
    except OSError as exc:
        logger.debug("could not list %s for eviction (%s)", runs_dir, exc)
        return 0
    removed = 0
    for old in dirs[:max(0, len(dirs) - max(0, limit))]:
        try:
            for child in old.iterdir():
                child.unlink()
            old.rmdir()
            removed += 1
        except OSError as exc:  # a run still being written, or held open
            logger.debug("could not evict run %s (%s)", old.name, exc)
    return removed


def run_suite(directory: str | Path, *, app: Any = None,
              update_baselines: bool = False, pace: float | None = None,
              patience: float | None = None,
              work_dir: str | Path | None = None) -> dict:
    """Every case in a suite: replay, assert, and diff against its baseline.

    A case with no baseline yet is NOT a failure - it is a case that has never
    been run, and it reports itself that way (with the artifact written when
    ``update_baselines`` is set). A suite that failed the first time it was
    written would be a suite nobody adopts.
    """
    suite = load_suite(directory)
    root = Path(suite["root"])
    thresholds = dict(THRESHOLDS, **(suite.get("thresholds") or {}))
    suite_pace = suite.get("pace", 0.0) if pace is None else pace
    # A suite checked in for CI can declare how patient its driver must be on
    # the runner it will actually meet - a shared box is slower than the one
    # the suite was authored on, and buying margin here is honest where
    # loosening a threshold would not be.
    suite_patience = (float(suite.get("patience", 1.0)) if patience is None
                      else float(patience))
    cases: list[dict] = []
    for spec in suite["cases"]:
        name = str(spec.get("name") or spec.get("recording") or "case")
        entry: dict = {"name": name, "checks": [], "verdict": "pass"}
        try:
            run = replay(_suite_path(root, spec.get("recording")),
                         agent_id=spec.get("agent_id"), app=app,
                         pace=float(spec.get("pace", suite_pace)),
                         patience=float(spec.get("patience", suite_patience)),
                         override=spec.get("override"), work_dir=work_dir)
        except (GymError, OSError) as exc:
            entry.update(verdict="error", error=str(exc))
            cases.append(entry)
            continue
        entry["run"] = run
        entry["checks"] = _case_expectations(run, spec.get("expect"))

        baseline_path = root / (spec.get("baseline")
                                or f"baselines/{name}.json")
        case_thresholds = dict(thresholds, **(spec.get("thresholds") or {}))
        baseline = _read_json(baseline_path)
        stale = (baseline_staleness(baseline, case_thresholds)
                 if baseline is not None else None)
        if baseline is not None and stale is None:
            entry["comparison"] = compare(baseline, run, case_thresholds)
            entry["checks"] += entry["comparison"]["checks"]
        elif baseline is None:
            entry["baseline"] = f"none yet at {baseline_path}"
        elif update_baselines:
            # Loudly RE-baseline. The operator asked for the record to be
            # rewritten, so the stale one is replaced and the case says so -
            # this is the one path where a mismatch is not a finding.
            entry["baseline"] = f"stale, re-baselined: {stale}"
        else:
            # Refuse. A baseline recorded to answer a different question cannot
            # produce a verdict about this one, and "no comparison" reported as
            # a pass is exactly the silence this direction exists to remove.
            entry["baseline"] = f"stale at {baseline_path}: {stale}"
            entry["checks"].append(_check(
                "baseline_current",
                f"a baseline minted under {CHECK_SET}",
                f"{stale} - re-run with --update-baselines once you have "
                "decided the current behaviour is the new record", False))
        if update_baselines:
            write_baseline(baseline_path, run, case_thresholds)
            entry["baseline_written"] = str(baseline_path)
        if any(not c["pass"] for c in entry["checks"]):
            entry["verdict"] = "fail"
        cases.append(entry)

    failed = [c["name"] for c in cases if c["verdict"] != "pass"]
    return {
        "schema": SUITE_SCHEMA,
        "suite": suite.get("name") or root.name,
        "root": str(root),
        "thresholds": thresholds,
        "cases": cases,
        "totals": {"cases": len(cases), "failed": len(failed),
                   "checks": sum(len(c["checks"]) for c in cases)},
        "failed_cases": failed,
        "verdict": "pass" if not failed else "fail",
    }


def _suite_path(root: Path, recording_ref: Any) -> str | Path:
    """A case's recording, resolved relative to the suite it belongs to.

    Suites are meant to be checked in and moved between machines, so a relative
    reference has to win over anything on this box - but an absolute path (or a
    bare id in the service's own recordings dir) still works for a suite that
    is being authored against live recordings.
    """
    if not recording_ref:
        raise GymError("a suite case must name a recording")
    candidate = root / str(recording_ref)
    return candidate if candidate.exists() else str(recording_ref)


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------
class ReplayRequest(BaseModel):
    """`POST /v1/convai/replay` - re-run a recorded conversation."""

    recording: str = Field(..., min_length=1, max_length=400,
                           description="a recorded conversation id, a directory, "
                                       "or a path to a user.wav")
    agent_id: str | None = Field(None, max_length=200)
    pace: float = Field(0.0, ge=0.0, le=4.0,
                        description="0 = as fast as the loop can push (turn "
                                    "boundaries are identical either way), "
                                    "1 = real time, which is what a latency "
                                    "claim needs")
    polite: bool = Field(True, description="pause the feed while the agent has "
                                           "the floor, so an unpaced replay does "
                                           "not invent barge-ins the recording "
                                           "never had")
    patience: float = Field(1.0, ge=0.01, le=20.0,
                            description="multiplier on the driver's politeness "
                                        "deadlines. Raise it on a shared or "
                                        "loaded box, where the agent legitimately "
                                        "takes longer than the deadlines a fast "
                                        "box was sized for")
    compare_to: str | None = Field(None, max_length=400,
                                   description="path to an earlier run artifact "
                                               "to score this run against")
    override: dict | None = None


class CompareRequest(BaseModel):
    """`POST /v1/convai/compare` - score run B against run A, statelessly.

    Both artifacts travel IN the body: the caller (the studio, a CI job on
    another box) holds its own runs, and asking it to first write them to this
    server's disk so `compare_to` could name a path would make a pure function
    stateful for no reason.
    """

    a: dict = Field(..., description="the baseline run artifact")
    b: dict = Field(..., description="the candidate run artifact")
    thresholds: dict | None = Field(
        None, description="per-call overrides of the default bar; unknown "
                          "names are refused rather than silently unused")


@router.post("/v1/convai/compare")
def compare_runs(req: CompareRequest) -> dict:
    """Score two run artifacts. Pure arithmetic - no model stack, no lock.

    A wrong-shaped artifact is a 422 naming which side is wrong, because the
    likeliest caller error is handing this a comparison (or a suite result)
    where a run belongs - and compare() would then score two empty turn lists
    against each other and report a confident "pass" about nothing.
    """
    for side, run in (("a", req.a), ("b", req.b)):
        if run.get("schema") != RUN_SCHEMA:
            raise HTTPException(
                422, f"run '{side}' is not a {RUN_SCHEMA} artifact (schema: "
                     f"{run.get('schema')!r}) - pass the JSON a replay returned")
    limits: dict[str, float] | None = None
    if req.thresholds is not None:
        unknown = sorted(set(req.thresholds) - set(THRESHOLDS))
        if unknown:
            raise HTTPException(
                422, f"unknown threshold(s) {', '.join(unknown)} - "
                     f"available: {', '.join(sorted(THRESHOLDS))}")
        try:
            limits = {k: float(v) for k, v in req.thresholds.items()}
        except (TypeError, ValueError):
            raise HTTPException(422, "thresholds must be numbers")
    return compare(req.a, req.b, limits)


@router.post("/v1/convai/replay")
def replay_conversation(req: ReplayRequest) -> dict:
    """Replay a recording against this replica's agent, in this process.

    NOT async: a replay is a whole conversation of blocking work (audio decode,
    transcription, synthesis), and on the event loop it would stall every other
    request on the replica. `def` puts it on the threadpool - the same reason
    `/v1/speech-to-text` is a plain def.

    One replay at a time: the second caller is REFUSED rather than queued,
    because a replay whose numbers were measured while another replay had the
    worker pool is not a measurement of anything.
    """
    if not SETTINGS.convai_enabled:
        raise HTTPException(503, "conversational agents are disabled on this "
                                 "service (CONVAI_ENABLED=0), so there is "
                                 "nothing to replay a conversation against")
    if _REPLAY_LOCK.locked():
        raise HTTPException(409, "the gym is already replaying a conversation on "
                                 "this replica - try again when it finishes")
    baseline = None
    if req.compare_to:
        baseline = _read_json(Path(req.compare_to))
        if baseline is None:
            raise HTTPException(404, f"no run artifact at '{req.compare_to}'")
    try:
        run = replay(req.recording, agent_id=req.agent_id, pace=req.pace,
                     polite=req.polite, patience=req.patience,
                     override=req.override)
    except GymError as exc:
        raise HTTPException(404, str(exc))
    except OSError as exc:
        raise HTTPException(500, f"the replay could not read its audio ({exc})")
    out: dict = {"run": run}
    if baseline is not None:
        out["comparison"] = compare(baseline, run)
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _print_checks(checks: list[dict]) -> None:
    for c in checks:
        print(f"  {'PASS' if c['pass'] else 'FAIL'}  {c['check']}: {c['got']} "
              f"(want {c['want']})")


def _print_run(run: dict) -> None:
    totals = run["totals"]
    print("-" * 62)
    print(f"Gravitone gym run {run['run_id']}  [{run['source_name']}]")
    print("-" * 62)
    print(f"Agent: {run['agent_id']}  brain={run['brain'].get('backend')}  "
          f"timings={run['timings_source']}")
    print(f"Wire: {run['wire']['audio_s']}s of audio in "
          f"{run['wire']['frames']} frame(s), pace={run['wire']['pace']}, "
          f"polite={run['wire'].get('polite')}")
    print(f"Turns: {totals['turns']} ({totals['candidate_turns']} caller / "
          f"{totals['agent_turns']} agent), "
          f"{totals['interruptions']} interruption(s)")
    for field in ("answer_s", "transcribe_s"):
        d = totals[field]
        if d["n"]:
            print(f"  {field}: mean {d['mean']}s  p50 {d['p50']}s  "
                  f"max {d['max']}s  (n={d['n']})")
    manners = run.get("politeness") or {}
    if manners.get("gave_up"):
        # Printed above the drift, because it changes what the rest means.
        print(f"WARNING: the driver ran out of patience "
              f"({manners.get('floor_timeouts')} floor / "
              f"{manners.get('reply_timeouts')} reply timeout(s)) - this box "
              f"was too slow for a polite replay, so the turn structure below "
              f"is about the box. Re-run with --patience "
              f"{max(2.0, manners.get('patience', 1.0) * 2):.0f}.")
    drift = run.get("drift_vs_source") or {}
    if drift.get("available"):
        print(f"Drift vs the source transcript: WER {drift['wer']} "
              f"({drift['errors']}/{drift['reference_words']} words) - drift, "
              "not accuracy")


def _write(path: str | None, payload: dict) -> None:
    if not path:
        return
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(payload, indent=2), "utf-8")
    print(f"wrote {path}")


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m service.gym",
        description="replay recorded conversations as deterministic tests")
    sub = ap.add_subparsers(dest="command", required=True)

    run_cmd = sub.add_parser("run", help="replay one recording")
    run_cmd.add_argument("recording")
    run_cmd.add_argument("--agent", default=None)
    run_cmd.add_argument("--pace", type=float, default=0.0,
                         help="0 = as fast as the loop can push (default, and "
                              "the same default the library and POST "
                              "/v1/convai/replay use); 1.0 = real time, which "
                              "is what a latency claim needs")
    run_cmd.add_argument("--patience", type=float, default=1.0,
                         help="multiplier on the driver's politeness deadlines "
                              "- raise it on a shared or loaded box")
    run_cmd.add_argument("--barge-in", action="store_true",
                         help="do not pause the feed while the agent is talking "
                              "(an unpaced replay will then talk over it)")
    run_cmd.add_argument("--out", default=None)

    cmp_cmd = sub.add_parser("compare", help="score run B against run A")
    cmp_cmd.add_argument("baseline")
    cmp_cmd.add_argument("candidate")
    cmp_cmd.add_argument("--thresholds", default=None,
                         help="JSON file overriding the default bar")
    cmp_cmd.add_argument("--out", default=None)

    suite_cmd = sub.add_parser("suite", help="run a directory of goldens")
    suite_cmd.add_argument("directory")
    suite_cmd.add_argument("--update-baselines", action="store_true")
    suite_cmd.add_argument("--pace", type=float, default=None)
    suite_cmd.add_argument("--patience", type=float, default=None,
                           help="multiplier on the driver's politeness "
                                "deadlines, overriding the suite's own")
    suite_cmd.add_argument("--out", default=None)

    a = ap.parse_args(argv)
    try:
        if a.command == "run":
            run = replay(a.recording, agent_id=a.agent, pace=a.pace,
                         polite=not a.barge_in, patience=a.patience)
            _print_run(run)
            _write(a.out, run)
            return 0
        if a.command == "compare":
            baseline = _read_json(Path(a.baseline))
            candidate = _read_json(Path(a.candidate))
            missing = [p for p, v in ((a.baseline, baseline),
                                      (a.candidate, candidate)) if v is None]
            if missing:
                print(f"not a readable run artifact: {', '.join(missing)}")
                return 1
            limits = _read_json(Path(a.thresholds)) if a.thresholds else None
            result = compare(baseline, candidate, limits)
            print("-" * 62)
            print(f"Gravitone gym compare  [{result['verdict'].upper()}]")
            print("-" * 62)
            _print_checks(result["checks"])
            _write(a.out, result)
            return exit_code(result)
        result = run_suite(a.directory, update_baselines=a.update_baselines,
                           pace=a.pace, patience=a.patience)
        print("-" * 62)
        print(f"Gravitone gym suite {result['suite']}  "
              f"[{result['verdict'].upper()}]")
        print("-" * 62)
        for case in result["cases"]:
            print(f"{case['verdict'].upper():5} {case['name']}"
                  + (f"  ({case['error']})" if case.get("error") else ""))
            _print_checks(case["checks"])
        totals = result["totals"]
        print(f"{totals['cases']} case(s), {totals['checks']} check(s), "
              f"{totals['failed']} failed")
        _write(a.out, result)
        return 0 if result["verdict"] == "pass" else 2
    except GymError as exc:
        print(f"gym: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
