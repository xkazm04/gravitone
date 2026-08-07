"""What a conversation left behind: two aligned WAVs and a transcript.

A spoken test that cannot be played back is a number without evidence. When
`CONVAI_RECORD` is on, every conversation writes a directory:

    recordings/<conversation_id>/
        user.wav        what the caller's microphone sent
        agent.wav       what the agent said back
        transcript.json every turn, with timings
        meta.json       who was talking, which models, how it ended

**The two WAVs share one timeline.** Both start at t=0 of the conversation and
are padded so that sample N of one is the same instant as sample N of the
other: open them on two tracks and you are listening to the call as it
happened. This costs a little silence on disk and is the whole point — the
agent's audio is SENT much faster than it plays, so a naive recording of "the
bytes we sent" would compress its half of the conversation into the moments it
was transmitting and align with nothing.

**Off by default.** This service's claim is that audio does not leave the
machine; writing every caller's voice to disk unasked is a different promise,
and it is an operator's decision rather than a default. Turn it on for test
runs, where the recording IS the deliverable.

Writing is incremental, so a conversation that dies mid-call still leaves
everything it had recorded up to that point.
"""
from __future__ import annotations

import json
import logging
import time
import wave
from dataclasses import asdict, dataclass, field
from pathlib import Path

from service.atomicio import atomic_write_text, file_lock
from service.config import SETTINGS

logger = logging.getLogger("gravitone.convai")

SAMPLE_WIDTH = 2
# Oldest conversations are evicted past this. Recordings are evidence for a
# test run, not an archive, and an unbounded directory on a box that also holds
# model weights is how a disk fills up quietly.
MAX_CONVERSATIONS = 200


@dataclass
class Turn:
    role: str                 # "candidate" | "agent"  (the caller, and the agent)
    text: str
    at_s: float               # when this turn STARTED, from the top of the call
    # Only on a caller turn: the audio it was heard from, and what hearing it
    # cost. These are what a word-error-rate or latency report is computed from.
    audio_s: float | None = None
    transcribe_s: float | None = None
    # Only on an agent turn: end of the caller's speech to the agent's first
    # audio — the number a listener experiences as "how long it thought".
    answer_s: float | None = None
    interrupted: bool = False
    # Only on an agent turn: which mouth spoke each part of the reply —
    # {voice_id, tts, emotion (requested), used (spoken), fallback}. The
    # session hangs a LIVE list here and the renderer appends to it while
    # audio is still going out; close() serializes the final state. This is
    # the internal-lens telemetry: a care decision about a Character's slot
    # starts from knowing which slot actually spoke.
    spoke: list | None = None


def recordings_dir() -> Path:
    return Path(SETTINGS.convai_recordings_dir)


class Recorder:
    """One conversation's artifacts. Every method is a no-op when disabled, so
    the session code has no ``if recording:`` branches in it."""

    def __init__(self, conversation_id: str, rate: int, *, enabled: bool | None = None):
        self.enabled = SETTINGS.convai_record if enabled is None else enabled
        self.conversation_id = conversation_id
        self.rate = rate
        self.dir = recordings_dir() / conversation_id
        self.turns: list[Turn] = []
        self.meta: dict = {}
        self._started = time.monotonic()
        self._user: wave.Wave_write | None = None
        self._agent: wave.Wave_write | None = None
        self._user_samples = 0
        self._agent_samples = 0
        self._failed = False
        if not self.enabled:
            return
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            self._user = self._open("user.wav")
            self._agent = self._open("agent.wav")
        except OSError as exc:
            # A recording is evidence, never a precondition: if the disk says
            # no, the conversation still happens and the log says why it will
            # not be listenable afterwards.
            logger.error("convai %s: recording disabled (%s)", conversation_id, exc)
            self._failed = True
            self.enabled = False

    def _open(self, name: str) -> wave.Wave_write:
        handle = wave.open(str(self.dir / name), "wb")
        handle.setnchannels(1)
        handle.setsampwidth(SAMPLE_WIDTH)
        handle.setframerate(self.rate)
        return handle

    # -- audio --------------------------------------------------------------
    def heard(self, pcm: bytes) -> None:
        """Everything the caller's microphone sent — this is the master clock."""
        if not self.enabled or self._user is None:
            return
        self._user.writeframes(pcm)
        self._user_samples += len(pcm) // SAMPLE_WIDTH

    def spoke(self, pcm: bytes) -> None:
        """Audio handed to the client, placed where it will PLAY.

        The first chunk of a turn is padded out to the caller's clock so the
        agent's speech lands at the moment the caller heard it start, not at
        the moment the socket happened to transmit it.
        """
        if not self.enabled or self._agent is None:
            return
        if self._agent_samples < self._user_samples:
            gap = self._user_samples - self._agent_samples
            self._agent.writeframes(b"\x00" * (gap * SAMPLE_WIDTH))
            self._agent_samples += gap
        self._agent.writeframes(pcm)
        self._agent_samples += len(pcm) // SAMPLE_WIDTH

    # -- transcript ---------------------------------------------------------
    def turn(self, turn: Turn) -> None:
        self.turns.append(turn)

    def elapsed(self) -> float:
        return round(time.monotonic() - self._started, 3)

    def note(self, **fields) -> None:
        self.meta.update(fields)

    # -- close --------------------------------------------------------------
    def close(self, reason: str = "closed") -> None:
        """Flush the audio and write the transcript. Safe to call twice."""
        if not self.enabled:
            return
        self.enabled = False
        for handle in (self._user, self._agent):
            if handle is not None:
                try:
                    handle.close()
                except OSError:
                    pass
        self._user = self._agent = None
        payload = {
            "conversation_id": self.conversation_id,
            "duration_s": self.elapsed(),
            "sample_rate": self.rate,
            "ended": reason,
            "turns": [_turn_dict(t) for t in self.turns],
        }
        try:
            atomic_write_text(self.dir / "transcript.json",
                              json.dumps(payload, indent=2, ensure_ascii=False))
            atomic_write_text(self.dir / "meta.json",
                              json.dumps(dict(self.meta, ended=reason,
                                              duration_s=payload["duration_s"]),
                                         indent=2, ensure_ascii=False))
        except OSError as exc:
            logger.error("convai %s: could not write the transcript (%s)",
                         self.conversation_id, exc)
            return
        logger.info("convai %s recorded to %s (%.1fs, %d turns)",
                    self.conversation_id, self.dir, payload["duration_s"],
                    len(self.turns))
        evict_oldest()


def _turn_dict(turn: Turn) -> dict:
    """One turn as the transcript stores it. ``spoke`` is agent-only
    telemetry — absent, not null, on every turn that has none."""
    d = asdict(turn)
    if d.get("spoke") is None:
        d.pop("spoke", None)
    return d


# -- care marks --------------------------------------------------------------
# The operator's per-turn verdicts on a recorded conversation ("this reply
# sounds off — retrain angry"), stored beside the evidence they are about.
# Whole-document semantics: PUT replaces the list. The studio holds the full
# set while the operator listens, and a merge contract would invent conflict
# cases this surface does not have.

def _care_path(conversation_id: str) -> Path | None:
    """The care file for an id, or None for an id we never minted (same
    alnum-only rule as ``load`` — these are path segments)."""
    if not conversation_id or not conversation_id.isalnum():
        return None
    return recordings_dir() / conversation_id / "care.json"


def load_care(conversation_id: str) -> dict | None:
    """A conversation's care marks; ``{"marks": []}`` when none are stored
    yet; None when the conversation itself does not exist."""
    path = _care_path(conversation_id)
    if path is None or not path.parent.is_dir():
        return None
    try:
        found = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"marks": []}
    return found if isinstance(found, dict) else {"marks": []}


def save_care(conversation_id: str, marks: list[dict]) -> dict | None:
    """Replace a conversation's marks. None when the conversation is gone.

    The cross-process ``file_lock``, not just an atomic write: the service
    runs as N single-worker replicas, and two studio tabs saving through two
    replicas must serialize on the existence-check-then-write — ``os.replace``
    prevents a torn file, not a lost update.
    """
    path = _care_path(conversation_id)
    if path is None or not path.parent.is_dir():
        return None
    payload = {"marks": marks, "updated_at": round(time.time(), 3)}
    with file_lock(path.parent / ".care.lock"):
        if not path.parent.is_dir():
            return None
        atomic_write_text(path, json.dumps(payload, indent=2, ensure_ascii=False))
    return payload


def evict_oldest(limit: int = MAX_CONVERSATIONS) -> int:
    """Drop the oldest recordings past ``limit``. Returns how many went."""
    root = recordings_dir()
    if not root.is_dir():
        return 0
    dirs = sorted((d for d in root.iterdir() if d.is_dir()),
                  key=lambda d: d.stat().st_mtime)
    removed = 0
    for old in dirs[:max(0, len(dirs) - limit)]:
        try:
            for child in old.iterdir():
                child.unlink()
            old.rmdir()
            removed += 1
        except OSError as exc:  # a recording still being written, or held open
            logger.debug("could not evict %s (%s)", old.name, exc)
    return removed


def load(conversation_id: str) -> dict | None:
    """One conversation's transcript, or None if it was never recorded.

    The id is used as a path segment, so it is checked rather than trusted:
    anything with a separator or a parent reference in it is not an id this
    service ever minted.
    """
    if not conversation_id or not conversation_id.isalnum():
        return None
    path = recordings_dir() / conversation_id / "transcript.json"
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def listing(limit: int = 50) -> list[dict]:
    """Recent conversations, newest first — id, when, how long, how many turns."""
    root = recordings_dir()
    if not root.is_dir():
        return []
    out: list[dict] = []
    for d in sorted((d for d in root.iterdir() if d.is_dir()),
                    key=lambda d: d.stat().st_mtime, reverse=True)[:limit]:
        entry = {"conversation_id": d.name,
                 "recorded_at": round(d.stat().st_mtime, 3),
                 "audio": sorted(p.name for p in d.glob("*.wav"))}
        try:
            meta = json.loads((d / "meta.json").read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            # Present but unreadable means the call is still running (or died
            # mid-write). Saying "in progress" beats omitting it from the list.
            entry["status"] = "in_progress"
        else:
            entry.update({k: meta[k] for k in
                          ("agent_id", "duration_s", "turns", "ended", "brain")
                          if k in meta})
            entry["status"] = "complete"
        try:
            marks = json.loads((d / "care.json").read_text("utf-8")).get("marks")
            if isinstance(marks, list):
                entry["care_marks"] = len(marks)
        except (OSError, json.JSONDecodeError):
            pass  # no marks yet — absent, not zero
        out.append(entry)
    return out
