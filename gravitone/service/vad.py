"""Streaming speech gate — when did the caller start talking, and when did they stop.

The batch sibling of this file is ``ingest.detect_speech``: same idea (find
speech by LEVEL, with the threshold derived from the recording rather than
hardcoded), different constraint. Ingest has the whole file, so it measures a
percentile floor in one pass and hands the spans to ffmpeg. A conversation has
100 ms of audio and no future, so the floor here is *tracked* instead of
measured, and the decision that matters — "the turn is over, answer now" — has
to be made from silence alone, before anything else can happen.

Why level and not a neural VAD: this is the sovereign half of the product. A
level gate has no weights to download, no second inference competing with the
TTS pool for the cores the launcher pinned, and no opinion about which language
is being spoken. What it costs is discrimination — it hears a slammed door as
speech, where Silero would not. The transcriber is the backstop: a false onset
produces a segment Whisper returns empty text for, and an empty transcript is
dropped without ever becoming a turn (see convai._Session). Swapping in Silero
means replacing `_classify` and nothing else; the state machine around it does
not know what decided.

Three numbers do the real work, and all three are contracts with the client:

* ``hangover_ms`` — silence that ends a turn. It must be SHORTER than the
  trailing silence a client pads an utterance with (the headless harness pads
  900 ms), or the turn never ends and the caller waits forever.
* ``onset_frames`` — consecutive loud frames that start a turn. This is the
  barge-in trigger, so it is short enough to feel instant and long enough that
  one click does not cut the agent off mid-sentence.
* ``preroll_frames`` — audio kept from BEFORE the onset. Without it every
  utterance handed to the transcriber is missing its first consonant, which is
  a word error the transcriber cannot recover from because the sound is gone.

Two things this gate exposes for speculative turn-taking (service/convai.py),
both inert unless somebody asks:

* **The utterance in progress.** ``partial_pcm()`` / ``voiced_ms`` /
  ``in_hangover`` are read-only views of the buffer this gate is already
  keeping, so a caller can transcribe the utterance-so-far while it is still
  being spoken instead of waiting for SPEECH_END. Reading them changes nothing.
* **An echo reference.** ``expect_echo()`` says "we just put N seconds of audio
  at this level on the wire". While that window is open an ONSET needs a frame
  clearly louder than our own output could plausibly leak back as (level minus
  ``attenuation_db``); quieter loud frames are presumed to be us hearing
  ourselves. It suppresses only onsets — a caller who already has the floor is
  never re-judged — and it is the honest local answer to having no acoustic echo
  canceller: it cannot cancel the echo, it can only decline to mistake it for a
  new turn. Nothing calls it unless the session was configured to.

One consequence of tracking the floor rather than measuring it is worth stating
plainly, because it is a real cost and not a hypothetical: a gate whose FIRST
frame is already speech takes that level as the background and hears nothing
until the speaker pauses. In a conversation the microphone is open before
anyone talks, so this is the mid-utterance-connect case only, it costs exactly
one utterance, and the first pause resets the floor. ``ingest.detect_speech``
does not have this problem because it has the whole file to look at; that is
the trade, and it is asserted in test_vad rather than left to be discovered.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass

import numpy as np

# 20 ms frames: short enough that onset/hangover are expressible at the
# granularity a conversation needs, long enough that the RMS of one frame is a
# stable number rather than a sample of the waveform.
FRAME_MS = 20
SAMPLE_WIDTH = 2  # PCM16, the only format this service speaks on the wire

# Log floor for digital silence. Both this and the two numbers below are the
# same values ingest.py derives its batch threshold from — the gate should not
# disagree with itself about what "background" means depending on which door
# the audio came in through.
_DB_FLOOR = -90.0
_NOISE_MARGIN_DB = 8.0
# Rails on the derived threshold. The low end matters most here: a client that
# pads with TRUE digital silence drags the tracked floor to -90 dB, and without
# a clamp the gate would then trigger on dither.
_THRESHOLD_CLAMP = (-75.0, -12.0)
# How fast the tracked floor may rise, in dB per frame (1 dB/s at 20 ms).
# Downward it moves instantly — a quieter frame IS new evidence about the
# background — but upward it has to creep, or a long utterance would drag the
# floor up behind it and gate off the speaker's own quiet consonants.
_FLOOR_CREEP_DB = 0.02

SPEECH_START = "speech_start"
SPEECH_END = "speech_end"

# How much quieter than the audio we SENT its echo is assumed to arrive. A
# speaker-to-microphone path in a room loses well more than this, so 12 dB is
# the conservative end: it presumes less attenuation than reality, which means
# it suppresses less than it could rather than deafening the gate.
_ECHO_ATTENUATION_DB = 12.0
# Allowance for the client's playback lag — audio is SENT long before it is
# heard, so the window stays open past the audio's own duration.
_ECHO_LAG_MS = 250


@dataclass(frozen=True)
class Utterance:
    """One completed span of speech, ready to transcribe."""

    pcm: bytes           # PCM16 mono at the gate's rate, pre-roll included
    seconds: float
    started_at_s: float  # offset from the first sample ever fed
    ended_at_s: float
    peak_db: float
    # Why the span ended: "silence" (the caller stopped — the normal case),
    # "max_length" (a forced cut), "flush" (the socket closed mid-utterance).
    # A turn ended by anything but silence is a turn the caller had not
    # finished, which is worth saying out loud rather than inferring later.
    reason: str


@dataclass(frozen=True)
class GateEvent:
    kind: str                      # SPEECH_START | SPEECH_END
    utterance: Utterance | None = None


def frame_db(frame: np.ndarray) -> float:
    """RMS of one int16 frame in dBFS, floored at ``_DB_FLOOR``."""
    if frame.size == 0:
        return _DB_FLOOR
    rms = float(np.sqrt(np.mean(np.square(frame.astype(np.float64)))))
    if rms <= 0.0:
        return _DB_FLOOR
    return max(_DB_FLOOR, 20.0 * math.log10(rms / 32768.0))


class SpeechGate:
    """Feed it PCM16 as it arrives; it tells you where the turns are.

    Stateful and single-conversation: one gate per session, never shared.
    """

    def __init__(self, rate: int = 16000, *, hangover_ms: int = 600,
                 onset_frames: int = 3, preroll_frames: int = 5,
                 min_speech_ms: int = 250, max_speech_ms: int = 30_000):
        self.rate = rate
        self.frame_samples = max(1, int(rate * FRAME_MS / 1000))
        self.frame_bytes = self.frame_samples * SAMPLE_WIDTH
        self.onset_frames = max(1, onset_frames)
        self.hangover_frames = max(1, int(hangover_ms / FRAME_MS))
        self.min_speech_frames = max(1, int(min_speech_ms / FRAME_MS))
        self.max_speech_frames = max(self.min_speech_frames,
                                     int(max_speech_ms / FRAME_MS))

        self._residual = bytearray()          # bytes short of a whole frame
        self._preroll: deque[bytes] = deque(maxlen=max(0, preroll_frames))
        self._voiced: list[bytes] = []        # frames of the utterance in progress
        self._floor_db: float | None = None
        self._loud_run = 0                    # consecutive frames over threshold
        self._quiet_run = 0                   # consecutive frames under it
        self._speaking = False
        self._peak_db = _DB_FLOOR
        self._frames_seen = 0                 # every frame ever, = the clock
        self._utterance_start_frame = 0
        # Echo reference (see expect_echo). Zero frames = no window open, which
        # is the state a gate stays in forever unless a caller opts in.
        self._echo_frames = 0
        self._echo_gate_db = _DB_FLOOR
        self.suppressed_onsets = 0            # frames declined as our own output

    # -- state a caller can ask about ---------------------------------------
    @property
    def speaking(self) -> bool:
        """True between SPEECH_START and its SPEECH_END."""
        return self._speaking

    @property
    def in_hangover(self) -> bool:
        """Speaking, but the last frame(s) were quiet — the turn may be ending.

        This is the window a speculative turn is allowed to think in: the caller
        has stopped making noise but has not yet been declared finished.
        """
        return self._speaking and self._quiet_run > 0

    @property
    def voiced_ms(self) -> int:
        """How much speech the utterance in progress holds, in milliseconds."""
        return len(self._voiced) * FRAME_MS

    def partial_pcm(self) -> bytes:
        """The utterance SO FAR — pre-roll included, nothing trimmed.

        A copy of what this gate already holds; calling it does not advance,
        consume or otherwise disturb the state machine. Empty when no utterance
        is in progress.
        """
        return b"".join(self._voiced)

    @property
    def echo_active(self) -> bool:
        """Whether an echo reference window is currently open."""
        return self._echo_frames > 0

    @property
    def floor_db(self) -> float | None:
        """The tracked background level, or None before the first frame."""
        return self._floor_db

    @property
    def threshold_db(self) -> float:
        """Level a frame must beat to count as speech, given what has been heard."""
        floor = self._floor_db if self._floor_db is not None else _DB_FLOOR
        return min(max(floor + _NOISE_MARGIN_DB, _THRESHOLD_CLAMP[0]),
                   _THRESHOLD_CLAMP[1])

    def _now_s(self) -> float:
        return self._frames_seen * FRAME_MS / 1000.0

    # -- the loop -----------------------------------------------------------
    def feed(self, pcm: bytes) -> list[GateEvent]:
        """Consume audio, return whatever turn boundaries it crossed.

        Any byte count is fine; a partial frame is held until the rest of it
        arrives, so a client's chunk size never changes where the turns land.
        """
        events: list[GateEvent] = []
        if pcm:
            self._residual.extend(pcm)
        while len(self._residual) >= self.frame_bytes:
            frame = bytes(self._residual[:self.frame_bytes])
            del self._residual[:self.frame_bytes]
            events.extend(self._consume_frame(frame))
        return events

    def _consume_frame(self, frame: bytes) -> list[GateEvent]:
        samples = np.frombuffer(frame, dtype="<i2")
        db = frame_db(samples)
        loud = db >= self.threshold_db  # threshold reads the PREVIOUS floor
        self._track_floor(db, loud)
        self._frames_seen += 1
        # This frame is judged against the window that was open when it arrived,
        # THEN the window is spent. It is spent in GATE time (one frame per frame
        # heard) rather than wall time, so a client that stalls its microphone
        # cannot let the window lapse while its speaker is still playing.
        echoing = self._echo_frames > 0
        if echoing:
            self._echo_frames -= 1

        if not self._speaking:
            events = self._maybe_start(frame, db, loud, echoing)
        else:
            # A caller who already has the floor is never re-judged: the echo
            # reference suppresses ONSETS, and nothing else.
            events = self._continue(frame, db, loud)
        if self._echo_frames == 0:
            self._echo_gate_db = _DB_FLOOR
        return events

    def _track_floor(self, db: float, loud: bool) -> None:
        if self._floor_db is None:
            self._floor_db = db
        elif db < self._floor_db:
            self._floor_db = db          # quieter than anything yet: that IS the floor
        elif not loud:
            self._floor_db = min(self._floor_db + _FLOOR_CREEP_DB, db)

    def _maybe_start(self, frame: bytes, db: float, loud: bool,
                     echoing: bool = False) -> list[GateEvent]:
        if loud and echoing and db < self._echo_gate_db:
            # Loud, but no louder than our own output plausibly leaks back as.
            # Presumed to be us; it does not start a turn and it does not
            # advance the onset run. Counted, because a suppression that cannot
            # be measured cannot be tuned.
            self.suppressed_onsets += 1
            loud = False
        if not loud:
            self._loud_run = 0
            self._preroll.append(frame)
            return []
        self._loud_run += 1
        self._preroll.append(frame)
        if self._loud_run < self.onset_frames:
            return []
        # Onset confirmed. The pre-roll ring already holds these loud frames AND
        # the quiet ones before them, so the utterance starts with its own
        # leading edge intact rather than `onset_frames` into the first word.
        self._voiced = list(self._preroll)
        self._utterance_start_frame = self._frames_seen - len(self._voiced)
        self._preroll.clear()
        self._speaking = True
        self._quiet_run = 0
        self._peak_db = db
        return [GateEvent(SPEECH_START)]

    def _continue(self, frame: bytes, db: float, loud: bool) -> list[GateEvent]:
        self._voiced.append(frame)
        self._peak_db = max(self._peak_db, db)
        if loud:
            self._quiet_run = 0
        else:
            self._quiet_run += 1
        if self._quiet_run >= self.hangover_frames:
            return self._end("silence")
        if len(self._voiced) >= self.max_speech_frames:
            return self._end("max_length")
        return []

    def _end(self, reason: str) -> list[GateEvent]:
        """Close the utterance in progress and hand it over."""
        frames = self._voiced
        self._voiced = []
        self._speaking = False
        self._loud_run = 0
        self._quiet_run = 0
        peak = self._peak_db
        self._peak_db = _DB_FLOOR

        # Trailing silence is the END SIGNAL, not part of what was said. Whisper
        # is happier without it and the duration we report stays honest.
        if reason == "silence":
            frames = frames[:max(0, len(frames) - self.hangover_frames)]
        if len(frames) < self.min_speech_frames:
            # Too short to be a word: a click, a chair, a breath. Dropped
            # silently — reporting it as a turn would put an empty transcript
            # into the conversation.
            return []
        started = self._utterance_start_frame * FRAME_MS / 1000.0
        seconds = len(frames) * FRAME_MS / 1000.0
        return [GateEvent(SPEECH_END, Utterance(
            pcm=b"".join(frames), seconds=round(seconds, 3),
            started_at_s=round(started, 3), ended_at_s=round(started + seconds, 3),
            peak_db=round(peak, 1), reason=reason,
        ))]

    def expect_echo(self, level_db: float, seconds: float, *,
                    lag_ms: int = _ECHO_LAG_MS,
                    attenuation_db: float = _ECHO_ATTENUATION_DB) -> None:
        """Declare audio WE just sent, so its echo cannot start a turn.

        ``level_db`` is the RMS level of the PCM handed to the client and
        ``seconds`` how long it plays. For that long (plus ``lag_ms`` for the
        client's playback delay) an onset needs a frame louder than
        ``level_db - attenuation_db``; anything at or below that is consistent
        with our own output leaking into the caller's microphone and is not
        treated as a new turn.

        Windows EXTEND rather than replace, and the level is the loudest of the
        overlapping ones — back-to-back chunks of one reply are one echo window,
        judged by its loudest part.

        This is not echo cancellation and does not pretend to be: the caller's
        real speech over ours is still heard the moment it is clearly louder
        than the leak, and a caller who already has the floor is untouched.
        """
        window = max(0.0, seconds) + max(0, lag_ms) / 1000.0
        frames = int(window * 1000.0 / FRAME_MS)
        if frames <= 0:
            return
        self._echo_frames = max(self._echo_frames, frames)
        self._echo_gate_db = max(self._echo_gate_db, level_db - attenuation_db)

    def flush(self) -> list[GateEvent]:
        """End an utterance still in progress — the socket closed mid-sentence.

        Nothing is invented: if the caller was not speaking, this returns
        nothing at all.
        """
        if not self._speaking:
            return []
        return self._end("flush")
