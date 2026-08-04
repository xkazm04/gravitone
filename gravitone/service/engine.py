"""Synthesis engine: a bounded pool of independent Pocket TTS model instances.

Why a pool of separate models instead of one shared model + threads:
`TTSModel.generate_audio[_stream]` is explicitly NOT thread-safe (see the
docstrings in pocket_tts/models/tts_model.py) — concurrent calls on one
instance corrupt state. So each worker thread owns its own fully-loaded
model. WORKERS is therefore the true parallelism ceiling; requests beyond it
wait in a bounded queue, and requests beyond (WORKERS + QUEUE_MAX) are
rejected with 429 so latency degrades predictably instead of unboundedly.

The engine also exposes live metrics (in-flight, queue depth, latency
percentiles, real-time factor) that the load-test harness reads to locate the
degradation knee.
"""
from __future__ import annotations

import contextlib
import functools
import io
import itertools
import logging
import math
import os
import platform
import queue
import subprocess
import threading
import time
import wave
from collections import OrderedDict, deque
from concurrent.futures import Future
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import scipy.io.wavfile
import scipy.signal
import torch

from service.config import SETTINGS

logger = logging.getLogger("gravitone.engine")


# ----------------------------------------------------------------------------
# Worker liveness (see TtsEngine.start / _worker_exited)
# ----------------------------------------------------------------------------
# How long start() waits for ONE worker to finish loading its model before
# declaring startup failed. Previously start() waited forever: a model load that
# raised left `ready` unset and hung the lifespan, so the process bound no port,
# served no /health and looked "still starting" to every supervisor above it.
# Generous by default (a cold CPU-only load is slow); env-overridable because
# the right number is hardware, not code.
_MODEL_LOAD_TIMEOUT_S = float(os.environ.get("TTS_MODEL_LOAD_TIMEOUT_S") or 600)

# How many times one worker SLOT may be replaced after an unexpected death
# before the engine gives up on it. Bounded on purpose: restarting forever would
# turn a deterministic crash (poisoned model, broken dependency) into a silent
# hot loop. When the budget is spent the engine marks itself failed, logs
# CRITICAL and reports not-ready on /health so the existing process supervisor
# (service/replicas.py) replaces the whole replica.
_WORKER_RESTART_MAX = 3

# Consecutive scaffolding errors (queue.get / bookkeeping — NOT job failures,
# which have their own handler) tolerated before a worker gives up its loop.
_LOOP_ERRORS_MAX = 5


# ----------------------------------------------------------------------------
# The deadline contract (cost model, admission classes, elastic quality)
# ----------------------------------------------------------------------------
# Everything below is DEFAULT-OFF in the sense that matters: a caller that names
# no deadline, no class and no degradation gets exactly the previous behaviour —
# FIFO order, blind admission, full quality. The knobs only start deciding
# things when somebody asks them to.

CLASS_BULK = "bulk"                  # the default: long-form, batch renders
CLASS_INTERACTIVE = "interactive"    # convai turns, hero demo — latency first
_CLASSES = (CLASS_BULK, CLASS_INTERACTIVE)

# Scheduling horizon per class when the caller named no deadline. The queue key
# is `t_enqueue + horizon`, computed ONCE at enqueue time, which is what makes
# aging expressible in a static-priority heap: a bulk job enqueued at T beats an
# interactive job that arrives after T + (BULK - INTERACTIVE), so interactive
# work jumps the queue without ever being able to starve bulk work behind it.
_BULK_AGING_HORIZON_S = float(os.environ.get("TTS_BULK_AGING_HORIZON_S") or 30.0)
_INTERACTIVE_HORIZON_S = float(os.environ.get("TTS_INTERACTIVE_HORIZON_S") or 2.0)

# Floor on how tight an EXPLICIT deadline may make a job's QUEUE KEY.
#
# ``deadline_s`` arrives from a request body (``app.TTSRequest`` and friends),
# which makes it an unauthenticated priority knob: ``{"deadline_s": 0.001}``
# mints a key ahead of every interactive turn (t+2s) and ahead of every bulk job
# younger than the aging horizon — a starvation weapon costing one JSON field,
# and it bypasses the very bound ``_BULK_AGING_HORIZON_S`` exists to give. So
# the EFFECTIVE horizon of an explicit deadline is floored PER CLASS:
#
#   * a BULK caller may schedule itself sooner than the 30s bulk horizon, but
#     never sooner than ``_INTERACTIVE_HORIZON_S`` — i.e. it can at best TIE the
#     interactive class it does not belong to, never outrank it;
#   * an INTERACTIVE caller may tighten inside its own class, down to this
#     floor but not to zero (a zero key is a permanent front-of-queue claim).
#
# The floor applies to the queue key ONLY. ``job.deadline_s`` keeps the caller's
# real number, because the degrade decision, the promise and the deadline-hit
# measurement must all be made against what the caller actually asked for —
# clamping the target would quietly turn "you asked for 1s" into "you asked for
# 2s" in the very metrics that exist to tell us whether we keep our word.
_INTERACTIVE_DEADLINE_FLOOR_S = float(
    os.environ.get("TTS_INTERACTIVE_DEADLINE_FLOOR_S") or 0.25)

# How often the queued-cost accounting is re-derived from the queue itself
# (TtsEngine._reconcile_pending). Event-driven — it runs on the submit path, not
# on a timer thread — and rate-limited to this, because the walk is cheap but
# not free and the number it corrects moves slowly.
_PENDING_RECONCILE_S = float(os.environ.get("TTS_PENDING_RECONCILE_S") or 1.0)

# Admission permits no BULK job may consume — the interactive floor. Zero by
# default ON PURPOSE: a non-zero floor changes who gets a 429 on a saturated
# box, and that is an operator decision, not a silent upgrade.
_INTERACTIVE_RESERVE = int(os.environ.get("TTS_INTERACTIVE_RESERVE") or 0)

# A promise is only ever made from a WARM window. Below this many completed
# synths the cost model still ESTIMATES (an estimate is useful), but it labels
# itself `cold`/`insufficient` and the API layer must not turn it into an
# X-Gravitone-Deadline header. A cost model that mispredicts turns promises into
# lies; refusing to promise is the only honest floor.
_WARM_WINDOW = int(os.environ.get("TTS_COST_WARM_WINDOW") or 20)

# Priors used to turn a request into an amount of AUDIO to produce. The engine
# records synth seconds and audio seconds, never text length, so the bridge from
# "this many characters" to "this many seconds of speech" is a constant. ~15
# characters per second of speech is the measured average for this model's
# languages; the token cap is the model's own ceiling on how much audio a single
# generate call can emit.
_AUDIO_S_PER_CHAR = 1.0 / 15.0
_AUDIO_S_PER_TOKEN = 0.02

# Real-time factor assumed when there is no window at all (basis=insufficient):
# 1.0 = "assume it renders at real time". Never used for a promise.
_COLD_RTF = 1.0

# The measured p95/p50 spread widens the estimate (a promise built on the median
# is wrong half the time), clamped so one pathological outlier cannot inflate
# every estimate on the box.
_MAX_SPREAD = 4.0

# Elastic quality ladder. Each level names the decode knobs it reduces and the
# fraction of the full-quality cost it is assumed to take. Applied ONLY when the
# caller opted in (degrade_allowed) AND the predicted wait misses their deadline,
# and always reported back on the job (Job.quality_level -> X-Quality-Level).
QUALITY_FULL = "full"
_QUALITY_LADDER = (
    # (level, lsd_decode_steps, frames_after_eos, ASSUMED cost fraction)
    ("reduced", 2, 2, 0.7),
    ("minimal", 1, 1, 0.5),
)

# The ladder fractions above are ASSUMPTIONS — 0.7 and 0.5 were invented, never
# measured. The engine now measures them: every completed synth is recorded
# against the quality level it ran at (Metrics.on_finish), and once a level has
# this many samples of its own its real cost fraction is computed from the
# observed real-time factors and used INSTEAD of the constant.
#
# Smaller than _WARM_WINDOW on purpose: degraded renders are rare by
# construction (they only happen under deadline pressure with the caller's
# permission), so a 20-sample gate would mean the fractions were never
# calibrated on any real box. What a thin window buys is a fraction, not a
# promise — and a promise built on an UNCALIBRATED fraction is withheld
# entirely (see TtsEngine.submit), which is the honest floor.
_LADDER_WARM_WINDOW = int(os.environ.get("TTS_LADDER_WARM_WINDOW") or 8)

# {level: assumed fraction} — the fallback when a level has no window yet.
_LADDER_ASSUMED = {level: fraction
                   for level, _steps, _frames, fraction in _QUALITY_LADDER}


# ----------------------------------------------------------------------------
# CPU / inference-path tuning (Arm pass)
# ----------------------------------------------------------------------------
# Gravitone is positioned as Arm-native CPU-only TTS, but the inference path
# had never been tuned for it. Everything below is applied ONCE per process and
# every knob is individually revertible from the environment (see
# service/config.py for each default and how to turn it off) — nothing here
# changes behaviour silently, and `benchmark_arm_ab.sh` A/Bs them one at a time
# through the existing loadtest harness.
IS_AARCH64 = platform.machine().lower() in ("aarch64", "arm64")

# Flipped to False if inference_mode turns out to be incompatible with the
# model at runtime; from then on generation uses the proven torch.no_grad()
# path. Also starts False when TTS_INFERENCE_MODE=0.
_INFERENCE_MODE_OK = SETTINGS.inference_mode


def _select_quantized_engine() -> str | None:
    """The int8 backend to use, or None to leave torch's own choice alone.

    Only consulted when SETTINGS.quantize is on. "auto" prefers qnnpack on
    aarch64 — the fp32 path there is oneDNN + Arm Compute Library, but the int8
    kernels come from qnnpack/XNNPACK, and some aarch64 wheels still default
    the quantized engine to an x86-oriented backend.
    """
    want = (SETTINGS.quantized_engine or "").strip().lower()
    if not want:
        return None
    supported = [str(e) for e in getattr(torch.backends.quantized,
                                         "supported_engines", [])]
    if want == "auto":
        if not IS_AARCH64:
            return None  # not our platform to second-guess
        return "qnnpack" if "qnnpack" in supported else None
    if supported and want not in supported:
        logger.warning("TTS_QUANTIZED_ENGINE=%s is not supported by this torch "
                       "build (%s); leaving the default engine", want, supported)
        return None
    return want


def _apply_cpu_tuning() -> dict:
    """Apply the process-global CPU settings. Returns what actually took effect
    (surfaced on /metrics) so an operator can see the truth, not the intent."""
    applied: dict = {}

    torch.set_num_threads(SETTINGS.torch_threads)
    applied["torch_threads"] = torch.get_num_threads()

    if SETTINGS.torch_interop_threads > 0:
        try:
            torch.set_num_interop_threads(SETTINGS.torch_interop_threads)
        except RuntimeError as exc:
            # torch only accepts this before the first parallel region. Losing
            # it is a missed optimization, never a correctness problem, so log
            # and carry on rather than failing start-up.
            logger.warning("could not set interop threads to %d (%s)",
                           SETTINGS.torch_interop_threads, exc)
    applied["torch_interop_threads"] = torch.get_num_interop_threads()

    if SETTINGS.flush_denormal:
        # False = this CPU/build has no FTZ control; report what happened.
        applied["flush_denormal"] = bool(torch.set_flush_denormal(True))
    else:
        applied["flush_denormal"] = False

    applied["quantized_engine"] = None
    if SETTINGS.quantize:
        engine = _select_quantized_engine()
        if engine:
            try:
                torch.backends.quantized.engine = engine
            except (RuntimeError, AttributeError) as exc:
                logger.warning("could not select quantized engine %s (%s)",
                               engine, exc)
        applied["quantized_engine"] = getattr(torch.backends.quantized,
                                              "engine", None)

    applied["inference_mode"] = _INFERENCE_MODE_OK
    applied["aarch64"] = IS_AARCH64
    logger.info("cpu tuning applied: %s", applied)
    return applied


def _generation_context():
    """Grad-free context for a generate call.

    ``inference_mode`` is strictly cheaper than ``no_grad`` (it also skips
    version counters and view tracking), but it produces *inference tensors*
    that some models refuse to reuse across calls. ``_note_inference_failure``
    demotes us to the proven ``no_grad`` path if that ever happens, so the
    optimization can never turn into an outage.
    """
    return torch.inference_mode() if _INFERENCE_MODE_OK else torch.no_grad()


def _note_inference_failure(exc: BaseException) -> bool:
    """True if `exc` looks like an inference_mode incompatibility AND we just
    demoted to no_grad — the caller should retry the generation once."""
    global _INFERENCE_MODE_OK
    if not _INFERENCE_MODE_OK:
        return False
    text = str(exc).lower()
    if "inference" not in text:  # e.g. "Inference tensors cannot be ..."
        return False
    _INFERENCE_MODE_OK = False
    logger.warning("torch.inference_mode is incompatible with this model (%s); "
                   "falling back to torch.no_grad for the rest of this process. "
                   "Set TTS_INFERENCE_MODE=0 to skip this probe entirely.", exc)
    return True


# ----------------------------------------------------------------------------
# Audio serialization
# ----------------------------------------------------------------------------
def audio_to_wav_bytes(audio: torch.Tensor, sample_rate: int) -> bytes:
    """Serialize a generated audio tensor to 16-bit PCM WAV bytes."""
    arr = audio.detach().to("cpu").squeeze().numpy()
    if arr.ndim > 1:  # [channels, samples] -> mono
        arr = arr.reshape(-1)
    if not np.issubdtype(arr.dtype, np.integer):
        arr = np.clip(arr, -1.0, 1.0)
        arr = (arr * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    scipy.io.wavfile.write(buf, sample_rate, arr)
    return buf.getvalue()


def concat_wavs(chunks: list[bytes]) -> bytes:
    """Join same-format WAVs (24kHz mono 16-bit) end to end. No ffmpeg needed."""
    chunks = [c for c in chunks if c]
    if not chunks:
        raise ValueError("no audio to concatenate")
    if len(chunks) == 1:
        return chunks[0]
    nch = sw = fr = None
    frames: list[bytes] = []
    for c in chunks:
        with wave.open(io.BytesIO(c), "rb") as w:
            if nch is None:
                nch, sw, fr = w.getnchannels(), w.getsampwidth(), w.getframerate()
            frames.append(w.readframes(w.getnframes()))
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(nch)  # type: ignore[arg-type]
        w.setsampwidth(sw)   # type: ignore[arg-type]
        w.setframerate(fr)   # type: ignore[arg-type]
        for f in frames:
            w.writeframes(f)
    return out.getvalue()


def wav_bytes_to_mp3(wav_bytes: bytes, bitrate: str = "128k",
                     sample_rate: int | None = None) -> bytes:
    """Transcode WAV -> MP3 via ffmpeg (must be on PATH). ElevenLabs default
    is MP3; we keep WAV as the fast path and encode MP3 only on request.

    ``bitrate`` (e.g. "192k") is passed to ffmpeg ``-b:a`` so the caller's
    requested ``mp3_{sr}_{bitrate}`` bitrate is honoured instead of a hardcoded
    128k. ``sample_rate`` (e.g. 44100), when given, is passed to ffmpeg ``-ar``
    so ffmpeg resamples to the requested rate as part of the encode."""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    # Cap the encoder's thread pool BEFORE it competes with the inference
    # threads the launcher just pinned (SETTINGS.ffmpeg_threads; 0 = ffmpeg's
    # own default, which is one thread per core). `-threads` is a per-stream
    # option, so it is given once for the input decoder and once for the mp3
    # encoder; `-filter_threads` covers the (possible) resample filter graph.
    if SETTINGS.ffmpeg_threads > 0:
        n = str(SETTINGS.ffmpeg_threads)
        cmd += ["-threads", n, "-filter_threads", n, "-i", "pipe:0", "-threads", n]
    else:
        cmd += ["-i", "pipe:0"]
    cmd += ["-f", "mp3", "-b:a", bitrate]
    if sample_rate is not None:
        cmd += ["-ar", str(sample_rate)]
    cmd.append("pipe:1")
    try:
        proc = subprocess.run(
            cmd, input=wav_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            # Bound the external encoder: a wedged ffmpeg (pathological input,
            # stalled binary) would otherwise pin the calling worker thread
            # forever with no request-timeout escape. Killed on timeout.
            timeout=60,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("ffmpeg mp3 encode timed out") from exc
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg mp3 encode failed: {proc.stderr.decode(errors='ignore')[:300]}")
    return proc.stdout


# ----------------------------------------------------------------------------
# Resampling (honouring pcm_{sr} / wav_{sr} output formats)
# ----------------------------------------------------------------------------
def _resample_factors(src_rate: int, dst_rate: int) -> tuple[int, int]:
    """(up, down) integer factors for a src->dst rate change, reduced by gcd.

    e.g. 24000 -> 16000 gives up=2, down=3 (16000/8000, 24000/8000)."""
    from math import gcd
    g = gcd(src_rate, dst_rate)
    return dst_rate // g, src_rate // g


def resample_pcm16(samples: "np.ndarray", src_rate: int, dst_rate: int) -> "np.ndarray":
    """Resample a mono int16 sample array from src_rate to dst_rate.

    Uses ``scipy.signal.resample_poly`` (polyphase FIR — the right tool for an
    integer-ratio rate change) with up/down factors derived from the gcd of the
    two rates. A no-op when the rates match. Returns int16 clamped to range."""
    if src_rate == dst_rate:
        return samples
    up, down = _resample_factors(src_rate, dst_rate)
    out = scipy.signal.resample_poly(samples.astype(np.float64), up, down)
    return np.clip(np.round(out), -32768, 32767).astype(np.int16)


def _read_wav_pcm16(wav_bytes: bytes) -> tuple["np.ndarray", int, int]:
    """(samples int16, sample_rate, channels) from a PCM16 WAV via stdlib wave."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        sr, nch = w.getframerate(), w.getnchannels()
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16), sr, nch


def _write_wav_pcm16(samples: "np.ndarray", sample_rate: int, channels: int = 1) -> bytes:
    """Serialize an int16 sample array to a PCM16 WAV via stdlib wave.

    Deliberately stdlib (not scipy.io.wavfile) so the header layout matches
    ``concat_wavs`` and the streaming route, and so it works under the test
    shims where scipy's writer is a stub."""
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(np.ascontiguousarray(samples, dtype="<i2").tobytes())
    return out.getvalue()


def resample_wav_bytes(wav_bytes: bytes, dst_rate: int) -> bytes:
    """Return WAV bytes resampled to dst_rate (no-op when already at dst_rate)."""
    samples, src_rate, nch = _read_wav_pcm16(wav_bytes)
    if src_rate == dst_rate:
        return wav_bytes
    return _write_wav_pcm16(resample_pcm16(samples, src_rate, dst_rate), dst_rate, nch)


# ----------------------------------------------------------------------------
# Metrics
# ----------------------------------------------------------------------------
class Metrics:
    """Thread-safe counters + a rolling latency/RTF window."""

    def __init__(self, window: int = 512):
        self._lock = threading.Lock()
        self.received = 0
        self.completed = 0
        self.rejected = 0     # 429s (admission refused)
        self.errored = 0
        self.timeouts = 0     # 504s (synthesis exceeded request_timeout_s)
        self.abandoned = 0    # jobs skipped un-run because the caller gave up
        self.cache_hits = 0   # requests served from the synthesis cache
        self.collapsed = 0    # requests served by another's in-flight render
        self.in_flight = 0    # currently inside generate()
        self.queued = 0       # admitted but not yet being processed
        self._latencies: deque[float] = deque(maxlen=window)   # end-to-end seconds
        self._proc: deque[float] = deque(maxlen=window)        # pure synth seconds
        self._audio: deque[float] = deque(maxlen=window)       # audio seconds produced
        # --- promises vs reality (the engine grading its own homework) ------
        # A promise nobody checks is a decoration. Every job that carried a
        # promised_s is compared to the latency it actually took, and every job
        # that carried a caller deadline is compared to that deadline.
        self.promises_kept = 0
        self.promises_missed = 0
        self.deadlines_met = 0
        self.deadlines_missed = 0
        # Deadlines no ladder rung could meet (see TtsEngine._degrade): the
        # engine ran at full quality and knew at admission it would miss.
        self.deadlines_unfittable = 0
        # Signed error, actual - promised: negative = came back early.
        self._promise_err: deque[float] = deque(maxlen=window)
        # Per-quality-level synth/audio windows, the raw material of a MEASURED
        # ladder fraction. Keyed by level; QUALITY_FULL is the denominator.
        self._level_proc: "dict[str, deque[float]]" = {}
        self._level_audio: "dict[str, deque[float]]" = {}
        self._window = window
        # Lifetime counter (not windowed) — feeds the "you'd have paid $X at
        # ElevenLabs" savings ticker in the web studio.
        self.audio_seconds_total = 0.0

    def on_received(self):
        with self._lock:
            self.received += 1

    def on_rejected(self):
        with self._lock:
            self.rejected += 1

    def on_timeout(self):
        with self._lock:
            self.timeouts += 1

    def on_cache_hit(self):
        """A request served from the synthesis cache: no admission, no worker.

        ``received`` is bumped here (and in ``on_collapsed``) because it means
        "requests this replica served". Once the cache started answering
        requests without going through ``submit``, ``received`` silently stopped
        counting them and every ratio computed from it was wrong.
        """
        with self._lock:
            self.received += 1
            self.cache_hits += 1

    def on_collapsed(self):
        """A request served by ANOTHER request's in-flight render (single
        flight): also never admitted, also a request this replica served."""
        with self._lock:
            self.received += 1
            self.collapsed += 1

    def on_abandoned(self):
        # A queued job the caller gave up on (504/disconnect): it was admitted
        # (queued++) but never started, so undo the queue count and tally it as
        # abandoned rather than errored/completed. Floored at zero: a gauge that
        # can go negative is a gauge nobody can act on, and the only cost of the
        # floor is that a miscount shows as 0 instead of as nonsense.
        with self._lock:
            self.queued = max(0, self.queued - 1)
            self.abandoned += 1

    def on_drain(self):
        # A queued job failed fast during graceful shutdown: undo its queue
        # count. Kept distinct from on_abandoned (no counter bump) — draining is
        # an operator action, not caller behaviour.
        with self._lock:
            self.queued = max(0, self.queued - 1)

    def on_enqueue(self):
        with self._lock:
            self.queued += 1

    @contextlib.contextmanager
    def job_running(self):
        """Own the ``in_flight`` gauge for the duration of one job.

        The ONLY place ``in_flight`` moves. It goes up on entry and comes down
        exactly once on exit — in a ``finally``, so it survives a BaseException
        that kills the worker thread. When ``on_start``/``on_error`` moved it
        from opposite ends, a worker dying at the wrong instant inflated the
        gauge permanently, and an inflated gauge is what an operator (and the
        load-test knee finder) reads as "the pool is busy".
        """
        with self._lock:
            self.queued = max(0, self.queued - 1)
            self.in_flight += 1
        try:
            yield
        finally:
            with self._lock:
                self.in_flight = max(0, self.in_flight - 1)

    def on_finish(self, latency_s: float, proc_s: float, audio_s: float,
                  quality_level: str = QUALITY_FULL,
                  promised_s: Optional[float] = None,
                  deadline_s: Optional[float] = None):
        """Record one completed synthesis — and GRADE it.

        ``promised_s`` is what the engine told the caller at admission
        (X-Gravitone-Deadline); ``deadline_s`` is what the caller asked for.
        Both are optional because most jobs carry neither, and a job that was
        never promised anything can neither keep nor break a promise — it is
        left out of the rate entirely rather than counted as a hit.

        ``quality_level`` is what actually ran, which is what makes the elastic
        ladder measurable instead of assumed (see ``ladder_fractions``).
        """
        # in_flight is NOT touched here — job_running owns it.
        with self._lock:
            self.completed += 1
            self._latencies.append(latency_s)
            self._proc.append(proc_s)
            self._audio.append(audio_s)
            self.audio_seconds_total += audio_s
            level = quality_level or QUALITY_FULL
            self._level_proc.setdefault(
                level, deque(maxlen=self._window)).append(proc_s)
            self._level_audio.setdefault(
                level, deque(maxlen=self._window)).append(audio_s)
            if promised_s is not None:
                self._promise_err.append(latency_s - promised_s)
                if latency_s <= promised_s:
                    self.promises_kept += 1
                else:
                    self.promises_missed += 1
            if deadline_s is not None:
                if latency_s <= float(deadline_s):
                    self.deadlines_met += 1
                else:
                    self.deadlines_missed += 1

    def on_deadline_unfittable(self):
        """A deadline no ladder rung could meet: recorded at admission.

        The job still runs at full quality (``TtsEngine._degrade``), so it will
        ALSO be counted as a deadline miss when it completes. The two are
        different facts: one says "we could not have made it however cheaply we
        rendered", the other says "we did not make it"."""
        with self._lock:
            self.deadlines_unfittable += 1

    def on_error(self):
        # in_flight is NOT touched here — job_running owns it.
        with self._lock:
            self.errored += 1

    @staticmethod
    def _pct(ordered, p):
        """Percentile of an ALREADY-SORTED sequence.

        Sorting is the caller's job precisely so a snapshot sorts each window
        once instead of once per percentile (it used to sort the 512-element
        latency deque three times over).
        """
        if not ordered:
            return None
        k = min(len(ordered) - 1, int(round((p / 100.0) * (len(ordered) - 1))))
        return round(ordered[k], 4)

    def counters(self) -> dict:
        """The cheap half of `snapshot`: counters and gauges, no percentiles.

        O(1) under the lock. This is what the 429 backpressure response reports
        — that path fires exactly when the box is saturated, which is the worst
        possible moment to sort three 512-element windows on the event loop for
        latency figures nobody reads off a rejection.
        """
        with self._lock:
            return {
                "received": self.received,
                "completed": self.completed,
                "rejected_429": self.rejected,
                "errored": self.errored,
                "timeouts": self.timeouts,
                "abandoned": self.abandoned,
                "cache_hits": self.cache_hits,
                "collapsed": self.collapsed,
                "in_flight": self.in_flight,
                "queued": self.queued,
                "audio_seconds_total": round(self.audio_seconds_total, 2),
            }

    def cost_model(self) -> dict:
        """What the engine currently knows about its own speed.

        Derived from the SAME ``_proc`` / ``_audio`` windows ``snapshot`` reads —
        no new measurement, just the decision-shaped view of it:

        * ``realtime_factor`` — audio seconds produced per compute second;
        * ``spread`` — the measured p95/p50 ratio of synth time, the amount by
          which a median-based estimate has to be widened to be a promise;
        * ``basis`` — ``warm`` (enough samples to promise from), ``cold`` (some
          samples, estimate only) or ``insufficient`` (no samples at all).

        Nested under one key on ``snapshot`` deliberately: every top-level
        scalar there is either summed into pool totals or explicitly classified
        as non-additive by ``replicas.AGG_KEYS`` (see its contract test), and a
        ratio is neither summable nor averageable across replicas.
        """
        with self._lock:
            proc = sorted(self._proc)
            audio = list(self._audio)
        rtf = None
        total_proc, total_audio = sum(proc), sum(audio)
        if proc and audio and total_audio > 0 and total_proc > 0:
            rtf = total_audio / total_proc
        p50, p95 = self._pct(proc, 50), self._pct(proc, 95)
        spread = 1.0
        if p50 and p95 and p50 > 0:
            spread = min(_MAX_SPREAD, max(1.0, p95 / p50))
        if rtf and len(proc) >= _WARM_WINDOW:
            basis = "warm"
        elif rtf:
            basis = "cold"
        else:
            basis = "insufficient"
        return {
            "basis": basis,
            "realtime_factor": round(rtf, 3) if rtf else None,
            "spread": round(spread, 3),
            "samples": len(proc),
            "warm_at": _WARM_WINDOW,
            "audio_s_per_char": _AUDIO_S_PER_CHAR,
        }

    def ladder_fractions(self) -> "dict[str, tuple[Optional[float], str]]":
        """``{level: (fraction, basis)}`` — MEASURED cost fractions when known.

        The fraction is the level's cost per second of audio relative to full
        quality, i.e. ``rtf_full / rtf_level``, computed from the two windows
        the engine already keeps per level. ``basis`` is ``"measured"`` when
        both windows are thick enough (``_LADDER_WARM_WINDOW`` for the level,
        ``_WARM_WINDOW`` for full quality) and ``"assumed"`` otherwise — in
        which case the fraction is None and the caller falls back to the
        ladder's invented constant AND must not turn the result into a promise.

        Clamped to (0, 1]: a "cheaper" level that measured SLOWER than full
        quality is not a saving, and letting a noisy window claim a fraction of
        3.0 would make the estimate worse than the constant it replaced.
        """
        with self._lock:
            full_proc = sum(self._level_proc.get(QUALITY_FULL, ()))
            full_audio = sum(self._level_audio.get(QUALITY_FULL, ()))
            full_n = len(self._level_proc.get(QUALITY_FULL, ()))
            levels = {lv: (sum(self._level_proc.get(lv, ())),
                           sum(self._level_audio.get(lv, ())),
                           len(self._level_proc.get(lv, ())))
                      for lv, _s, _f, _fr in _QUALITY_LADDER}
        out: "dict[str, tuple[Optional[float], str]]" = {}
        full_ok = full_n >= _WARM_WINDOW and full_proc > 0 and full_audio > 0
        full_cost_per_audio_s = (full_proc / full_audio) if full_ok else None
        for level, (proc, audio, n) in levels.items():
            if (not full_ok or n < _LADDER_WARM_WINDOW
                    or proc <= 0 or audio <= 0):
                out[level] = (None, "assumed")
                continue
            frac = (proc / audio) / full_cost_per_audio_s
            out[level] = (round(min(1.0, max(0.01, frac)), 3), "measured")
        return out

    def promises(self) -> dict:
        """Promise-vs-actual, and deadline-vs-actual. The honesty surface.

        Nested under one key on ``snapshot`` for the same reason ``cost_model``
        is (see its docstring and ``replicas.AGG_KEYS``): rates and percentiles
        are neither summable nor averageable across replicas, and every
        top-level scalar in a snapshot must be classified as one or the other.

        ``hit_rate`` is None rather than 1.0 when nothing was promised — a rate
        over zero samples is not a perfect score, it is no score.
        """
        with self._lock:
            kept, missed = self.promises_kept, self.promises_missed
            met, dmissed = self.deadlines_met, self.deadlines_missed
            unfittable = self.deadlines_unfittable
            errors = sorted(self._promise_err)
        promised = kept + missed
        deadlines = met + dmissed
        return {
            "promised": promised,
            "kept": kept,
            "missed": missed,
            "hit_rate": round(kept / promised, 3) if promised else None,
            # Signed: negative means the engine came back EARLY. A promise
            # surface that only reported |error| would hide the difference
            # between "we are conservative" and "we are wrong".
            "error_p50_s": self._pct(errors, 50),
            "error_p95_s": self._pct(errors, 95),
            "error_mean_s": (round(sum(errors) / len(errors), 4)
                             if errors else None),
            "deadlines": {
                "seen": deadlines,
                "met": met,
                "missed": dmissed,
                "hit_rate": round(met / deadlines, 3) if deadlines else None,
                "unfittable": unfittable,
            },
            "ladder": {level: {"fraction": (frac if frac is not None
                                            else _LADDER_ASSUMED[level]),
                               "basis": basis,
                               "samples": len(self._level_proc.get(level, ()))}
                       for level, (frac, basis) in self.ladder_fractions().items()},
        }

    def cost_estimate(self, text_len: int, max_tokens: Optional[int] = None) -> dict:
        """Seconds of synthesis this request is expected to cost.

        ``text_len`` (characters) becomes expected audio seconds via the
        ``_AUDIO_S_PER_CHAR`` prior, capped by what ``max_tokens`` allows the
        model to emit at all; audio seconds become compute seconds through the
        measured real-time factor; and a WARM estimate is widened by the
        measured p95/p50 spread so the number is a number the engine can keep
        rather than the median it would miss half the time.

        Always returns a number — an estimate is useful even when it cannot be
        promised — and always says which it is via ``basis``. ``promise`` is
        True only for a warm window: that flag, not the estimate, is what the
        API layer gates ``X-Gravitone-Deadline`` on.
        """
        model = self.cost_model()
        est_audio_s = max(0, int(text_len or 0)) * _AUDIO_S_PER_CHAR
        if max_tokens and max_tokens > 0:
            est_audio_s = min(est_audio_s, max_tokens * _AUDIO_S_PER_TOKEN)
        rtf = model["realtime_factor"] or _COLD_RTF
        est = est_audio_s / rtf
        if model["basis"] == "warm":
            est *= model["spread"]   # only a measured spread may widen a promise
        return dict(model,
                    est_synth_s=round(est, 3),
                    est_audio_s=round(est_audio_s, 3),
                    promise=model["basis"] == "warm")

    def snapshot(self) -> dict:
        base = self.counters()
        with self._lock:
            lat = sorted(self._latencies)
            proc = sorted(self._proc)
            audio = list(self._audio)
        rtf = None
        if proc and audio and sum(audio) > 0:
            # >1.0 means faster than real-time (audio produced per second of compute)
            rtf = round(sum(audio) / sum(proc), 3)
        base.update({
            "latency_p50_s": self._pct(lat, 50),
            "latency_p95_s": self._pct(lat, 95),
            "latency_p99_s": self._pct(lat, 99),
            "synth_p50_s": self._pct(proc, 50),
            "realtime_factor": rtf,  # audio_seconds / compute_seconds
            "window_size": len(lat),
            # The decision layer's view of the same windows (nested — see
            # cost_model's docstring for why it is not top-level scalars).
            "cost_model": self.cost_model(),
            # Whether the decisions above turned out to be TRUE (also nested,
            # for the same AGG_KEYS reason: rates do not sum across replicas).
            "promises": self.promises(),
        })
        return base


# ----------------------------------------------------------------------------
# Job + worker
# ----------------------------------------------------------------------------
class _AbandonFlag(threading.Event):
    """The "caller gave up" signal (504 timeout or client disconnect).

    Setting it does not merely MARK the job: it runs the engine hook that
    releases the job's admission permit immediately. Before, the permit was held
    until a worker eventually dequeued the job and noticed the flag — with the
    shipped single worker and a deep queue that is minutes of capacity held for
    a caller who is gone, at exactly the moment the service is most loaded.

    The hook is idempotent (it goes through ``Job.claim``), so a double ``set``
    or a race between two setters can never double-release.
    """

    def __init__(self):
        super().__init__()
        self._on_abandon = None  # set by TtsEngine.submit before enqueueing

    def set(self):  # noqa: D102 - see class docstring
        super().set()
        hook = self._on_abandon
        if hook is not None:
            hook()


@dataclass
class Job:
    voice_id: str
    text: str
    max_tokens: int
    frames_after_eos: Optional[int]
    # Per-request expression overrides applied to the worker's model instance
    # (e.g. {"temp": 0.9, "noise_clamp": 1.2, "lsd_decode_steps": 3}). Safe
    # because a worker owns its model and processes exactly one job at a time.
    overrides: dict = field(default_factory=dict)
    future: Future = field(default_factory=Future)
    t_enqueue: float = field(default_factory=time.perf_counter)
    # --- the deadline contract -------------------------------------------
    # Seconds from admission by which the caller wants this finished. None is
    # the DEFAULT and means exactly what it meant before deadlines existed:
    # schedule me by arrival. A job with every one of these fields left alone is
    # FIFO-equivalent to the pre-deadline engine, which test_deadline_engine
    # pins field by field.
    deadline_s: Optional[float] = None
    # Which admission pool this job belongs to (CLASS_BULK / CLASS_INTERACTIVE).
    job_class: str = CLASS_BULK
    # Whether the CALLER allowed a cheaper render to make the deadline. Never
    # inferred: a caller who did not ask for degradation never gets it.
    degrade_allowed: bool = False
    # What the cost model expected this job to cost (seconds of synthesis).
    # Feeds the predicted wait every later admission decision is made from.
    est_synth_s: float = 0.0
    # The latency the engine PROMISED at admission (X-Gravitone-Deadline), or
    # None when it refused to promise — which is what a cold/insufficient window
    # means. None is not "no delay expected", it is "we will not put a number on
    # this yet", and the API layer must send no header rather than a guess.
    promised_s: Optional[float] = None
    # The quality level actually used. QUALITY_FULL unless elastic quality fired,
    # in which case the API layer reports it as X-Quality-Level — degradation
    # that a caller cannot see is worse than a 429.
    quality_level: str = QUALITY_FULL
    # How the degraded cost was arrived at: "measured" (the level's cost
    # fraction came from this engine's own observations) or "assumed" (it came
    # from the ladder's invented constant). None when nothing was degraded. A
    # promise resting on "assumed" is 30-50% guess, so submit() withholds it.
    degrade_basis: Optional[str] = None
    # Called exactly once, by whoever WINS claim(), to tell the engine this job
    # has left the queue's cost accounting. Wired by submit; None everywhere else
    # (a Job built by hand in a test owes the engine nothing).
    settle_hook: Optional[object] = field(default=None, repr=False)
    # Set by the API layer when the caller has given up (504 timeout or client
    # disconnect). Setting it releases the admission permit AT THAT MOMENT (see
    # _AbandonFlag / TtsEngine._release_abandoned) and leaves the job in the
    # queue as a tombstone the next worker discards. There is no mid-generation
    # cancellation: generate_audio is a single atomic C/torch call with no
    # cooperative cancel point, so a job already inside the model runs to
    # completion; only jobs still queued can be skipped.
    abandoned: _AbandonFlag = field(default_factory=_AbandonFlag)
    # --- the claim (see claim()) -----------------------------------------
    _claim_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _claimed: bool = field(default=False, repr=False)

    def claim(self) -> bool:
        """Take exclusive ownership of this job's ONE permit and ONE future.

        Three paths can end a job — a worker about to run it, the abandon hook,
        the shutdown drain — and exactly one of them may release its admission
        permit and resolve its future. Whoever wins this claim owns those two
        actions; every later caller gets False and must do nothing at all.

        That is what makes "released early, dequeued later" structurally safe
        rather than a comment: once the abandon hook has claimed a job, no
        worker can run it, re-release its permit or re-resolve its future, no
        matter how the timing falls.
        """
        with self._claim_lock:
            if self._claimed:
                return False
            self._claimed = True
        # Outside the lock, and best-effort: the claim is the single choke point
        # every exit path (run, abandon, drain) passes through exactly once, so
        # it is the only correct place to stop counting this job's estimated
        # cost against the queue. A bookkeeping failure must never turn a valid
        # claim into a lost job.
        hook = self.settle_hook
        if hook is not None:
            try:
                hook()
            except Exception:  # noqa: BLE001 - accounting, not correctness
                logger.exception("job settle hook failed")
        return True


class _DeadlineQueue:
    """A ``queue.PriorityQueue`` keyed ``(priority, seq)`` with a Job-level API.

    A wrapper rather than a subclass because the things the engine puts on the
    queue — ``Job`` and the ``None`` shutdown sentinel — are not orderable
    against each other. Ordering lives entirely in the entry tuple; the payload
    is never compared, so two jobs with an identical priority fall back to
    ``seq`` (arrival order) and no comparison ever reaches a ``Job``.

    The claim/tombstone protocol is order-agnostic — a worker claims whatever it
    dequeues and a tombstone is discarded wherever it surfaces — so this is a
    container swap, not a redesign. With every job at the same horizon (the
    default), ``t_enqueue + horizon`` is monotonic in arrival, which makes the
    heap order EXACTLY the old FIFO order. That equivalence is the pinned
    contract, not a happy accident.

    ``put(None)`` gets ``+inf``: the shutdown sentinel sat at the tail of the
    FIFO and must keep sitting at the tail, or a worker would take it while real
    jobs are still queued.
    """

    def __init__(self) -> None:
        self._q: "queue.PriorityQueue[tuple[float, int, Optional[Job]]]" = \
            queue.PriorityQueue()
        self._seq = itertools.count()
        self._seq_lock = threading.Lock()

    def _next_seq(self) -> int:
        # itertools.count() is atomic in CPython, but the lock costs nothing on
        # this path and does not depend on that being true.
        with self._seq_lock:
            return next(self._seq)

    def put(self, item: "Optional[Job]", priority: Optional[float] = None) -> None:
        if priority is None:
            priority = math.inf if item is None else item.t_enqueue
        self._q.put((priority, self._next_seq(), item))

    def get(self, block: bool = True, timeout: Optional[float] = None):
        return self._q.get(block, timeout)[2]

    def get_nowait(self):
        return self._q.get_nowait()[2]

    def task_done(self) -> None:
        self._q.task_done()

    def pending_est_s(self) -> float:
        """The TRUTH about queued cost: sum ``est_synth_s`` over the jobs that
        are really still on this queue and not yet claimed.

        The engine's running total is maintained by increment/decrement, which
        is cheap and drifts (a settle hook that raised, a Job built outside
        submit, a counter that was never reconciled against anything). This is
        what it is reconciled AGAINST — a snapshot of the heap list, which is
        bounded by ``workers + queue_max``, so it is a short walk and not a
        sweeper. Claimed jobs are excluded: a claim has already settled their
        cost, and the queue entry left behind is a tombstone.
        """
        with self._q.mutex:
            entries = list(self._q.queue)
        total = 0.0
        for _priority, _seq, job in entries:
            if job is None or getattr(job, "_claimed", False):
                continue
            total += float(getattr(job, "est_synth_s", 0.0) or 0.0)
        return total

    def qsize(self) -> int:
        return self._q.qsize()

    def empty(self) -> bool:
        return self._q.empty()


@dataclass
class SynthResult:
    wav_bytes: bytes
    sample_rate: int
    audio_seconds: float
    synth_seconds: float
    queue_seconds: float


# A worker loads a fresh model state per distinct voice and keeps it hot. The
# cache is bounded (LRU) so a long-lived process that serves many one-off voices
# doesn't grow its resident set without limit.
_VOICE_CACHE_MAX = 8


class _Worker(threading.Thread):
    def __init__(self, idx: int, engine: "TtsEngine", generation: int = 0):
        super().__init__(name=f"tts-worker-{idx}", daemon=True)
        self.idx = idx
        self.engine = engine
        self.model = None
        # How many times this SLOT has been restarted (0 = the original worker).
        self.generation = generation
        # LRU: most-recently-used voice kept at the end; evict from the front.
        self._voice_cache: "OrderedDict[str, dict]" = OrderedDict()
        # Guards ONLY the dict bookkeeping below — never a model call. Another
        # thread (the replica's admin server, via TtsEngine.voice_lru_keys)
        # reads these keys while this worker mutates them, and iterating a live
        # OrderedDict from a second thread raises. An uncontended lock around
        # three dict operations is not measurable next to a generation.
        self._voice_lock = threading.Lock()
        # `ready` means "loaded AND serving": set after a successful load,
        # CLEARED again the moment the loop exits, so a dead worker never keeps
        # counting toward the engine's live capacity (see TtsEngine.ready).
        self.ready = threading.Event()
        # Set exactly once when the load attempt finishes, whether it succeeded
        # or raised. start() waits on THIS, never on `ready` — waiting on a flag
        # only set on success is what made a load failure hang startup forever.
        self.startup_done = threading.Event()
        self.load_error: BaseException | None = None

    # -- voice loading (per-instance; states are model-specific) -----------
    def _voice_state(self, voice_id: str) -> dict:
        with self._voice_lock:
            st = self._voice_cache.get(voice_id)
            if st is not None:
                self._voice_cache.move_to_end(voice_id)  # most-recently-used
                return st
        # 1) exported embedding in the voices dir, 2) a raw path, 3) a builtin name
        cand = Path(SETTINGS.voices_dir) / f"{voice_id}.safetensors"
        source = str(cand) if cand.is_file() else voice_id
        # OUTSIDE the lock: this is the expensive load, and holding a lock a
        # reader also wants across it would make an introspection scrape wait
        # on a model load.
        st = self.model.get_state_for_audio_prompt(source, truncate=True)
        with self._voice_lock:
            self._voice_cache[voice_id] = st
            self._voice_cache.move_to_end(voice_id)
            if len(self._voice_cache) > _VOICE_CACHE_MAX:
                self._voice_cache.popitem(last=False)  # evict least-recently-used
        return st

    def voice_cache_keys(self) -> list[str]:
        """This worker's resident voice ids, copied under its own lock.

        The copy is the whole point: handing a caller the live keys view meant
        the reader iterated a dict this thread was inserting into, and got a
        RuntimeError exactly when the box was busiest.
        """
        with self._voice_lock:
            return list(self._voice_cache.keys())

    # -- generation --------------------------------------------------------
    def _generate(self, state: dict, job: "Job"):
        """One generate_audio call inside the grad-free context.

        Autograd bookkeeping is pure overhead here — we never call backward —
        but it was never actually turned off on this path.
        """
        with _generation_context():
            return self.model.generate_audio(
                state, job.text,
                max_tokens=job.max_tokens,
                frames_after_eos=job.frames_after_eos,
                copy_state=True,  # reuse the cached voice state safely
            )

    def _load(self):
        from pocket_tts import TTSModel  # imported in-thread to avoid fork issues
        self.model = TTSModel.load_model(
            language=SETTINGS.language, quantize=SETTINGS.quantize
        )
        # Warm the default voice so the first real request isn't cold.
        try:
            self._voice_state(SETTINGS.default_voice)
        except Exception:  # noqa: BLE001 - default warmup is best-effort
            pass

    def run(self):
        try:
            self._load()
            self.ready.set()
        except BaseException as exc:  # noqa: BLE001 - a load failure must SAY so
            # Recorded (not swallowed): start() turns this into a loud,
            # non-zero-exit startup failure instead of a thread traceback that
            # nobody upstream ever sees.
            self.load_error = exc
            logger.exception("tts worker %d: model load failed", self.idx)
            return
        finally:
            self.startup_done.set()

        death: BaseException | None = None
        try:
            self._serve_forever()
        except BaseException as exc:  # noqa: BLE001 - a death must be VISIBLE
            death = exc
            logger.exception("tts worker %d: worker loop died", self.idx)
        finally:
            # Whatever happened, stop counting as live capacity and tell the
            # engine, which decides between a bounded restart and giving up.
            self.ready.clear()
            self.engine._worker_exited(self, death)

    def _serve_forever(self):
        """The dequeue loop.

        An unexpected exception in the loop SCAFFOLDING (queue.get, the
        bookkeeping around a job — a failing job itself is handled inside
        `_serve_once` and never reaches here) is logged and survived, up to
        ``_LOOP_ERRORS_MAX`` consecutive times. Past that the worker gives up
        and lets `run()` report the death: a loop that cannot even dequeue is
        not a worker any more, and pretending otherwise is the silent-outage
        shape this whole path exists to prevent.
        """
        consecutive = 0
        while not self.engine._stopping:
            try:
                if not self._serve_once():
                    return
            except Exception:  # noqa: BLE001 - survive, but not forever
                consecutive += 1
                logger.exception("tts worker %d: loop error %d/%d",
                                 self.idx, consecutive, _LOOP_ERRORS_MAX)
                if consecutive >= _LOOP_ERRORS_MAX:
                    raise
            else:
                consecutive = 0

    def _serve_once(self) -> bool:
        """Dequeue and (maybe) run one job. False means 'stop serving'."""
        try:
            job: Job = self.engine._queue.get(timeout=0.5)
        except queue.Empty:
            return True
        if job is None:  # shutdown sentinel
            return False
        if not job.claim():
            # A tombstone: the abandon hook (or the drain) already resolved this
            # job's future and released its permit. Touching either again would
            # double-release a permit — the queue entry is all that is left, so
            # drop it and move on. Structural, not a check we can forget.
            self.engine._queue.task_done()
            return True
        # From here the job is OURS: exactly one release, exactly one resolve.
        if job.abandoned.is_set():
            # The caller gave up between our claim and now (or while the job was
            # queued and the hook lost the claim race): skip synthesis rather
            # than burn a full generation on a result no one will read, release
            # the permit and resolve the future as cancelled (not errored).
            self.engine.metrics.on_abandoned()
            job.future.cancel()
            self.engine._admit.release()
            self.engine._queue.task_done()
            return True
        if self.engine._stopping:
            # Graceful drain raced this job onto us after shutdown began:
            # fail it fast rather than start a fresh generation. (Jobs
            # already inside generate_audio still run to completion.)
            if not job.future.done():
                job.future.set_exception(ShuttingDown("server shutting down"))
            self.engine.metrics.on_drain()
            self.engine._admit.release()
            self.engine._queue.task_done()
            return True
        self._run_job(job)
        return True

    def _run_job(self, job: "Job") -> None:
        """Synthesize one admitted job. The future ALWAYS resolves and the
        admission permit ALWAYS releases, including on a BaseException that goes
        on to kill this worker thread."""
        with self.engine.metrics.job_running():
            self._synthesize(job)

    def _synthesize(self, job: "Job") -> None:
        t_start = time.perf_counter()
        prev: dict = {}
        try:
            state = self._voice_state(job.voice_id)
            # apply expression overrides, remembering the originals
            for k, v in job.overrides.items():
                prev[k] = getattr(self.model, k)
                setattr(self.model, k, v)
            try:
                audio = self._generate(state, job)
            except RuntimeError as exc:
                # inference_mode is an optimization, never a contract: if
                # this model can't live with it, demote to no_grad and run
                # the SAME call again on the proven path. generate_audio is
                # atomic w.r.t. model state (copy_state=True), so retrying
                # is safe. Any other RuntimeError propagates untouched.
                if not _note_inference_failure(exc):
                    raise
                audio = self._generate(state, job)
            synth_s = time.perf_counter() - t_start
            wav = audio_to_wav_bytes(audio, self.model.sample_rate)
            audio_s = audio.detach().squeeze().numel() / self.model.sample_rate
            res = SynthResult(
                wav_bytes=wav, sample_rate=self.model.sample_rate,
                audio_seconds=round(audio_s, 3), synth_seconds=round(synth_s, 3),
                queue_seconds=round(t_start - job.t_enqueue, 3),
            )
            self.engine.metrics.on_finish(
                latency_s=time.perf_counter() - job.t_enqueue,
                proc_s=synth_s, audio_s=audio_s,
                # The grading inputs: what we PROMISED this caller, what they
                # ASKED for, and which quality level actually produced these
                # seconds (which is what calibrates the ladder).
                quality_level=job.quality_level,
                promised_s=job.promised_s,
                deadline_s=job.deadline_s,
            )
            job.future.set_result(res)
        except BaseException as exc:  # noqa: BLE001 - surface to caller
            # BaseException, not Exception: something like a MemoryError or a
            # thread-killing signal must still resolve this caller's future
            # (repo law) and un-count the in-flight job. Ordinary exceptions are
            # swallowed here — the caller sees them via the future — but a
            # non-Exception is re-raised so the loop dies VISIBLY instead of
            # this worker quietly disappearing while /health still says 200.
            self.engine.metrics.on_error()
            if not job.future.done():
                job.future.set_exception(exc)
            if not isinstance(exc, Exception):
                raise
        finally:
            for k, v in prev.items():  # always restore model defaults
                setattr(self.model, k, v)
            self.engine._admit.release()
            self.engine._queue.task_done()


# ----------------------------------------------------------------------------
# Engine
# ----------------------------------------------------------------------------
class AdmissionRejected(Exception):
    """Raised when the queue is full — maps to HTTP 429.

    Carries the TRUTH about the refusal, not just the fact of it: how long the
    caller would have waited had it been admitted (``predicted_wait_s``) and
    when it is worth coming back (``retry_after_s``). A 429 that says "try
    again" teaches the client nothing; a 429 that says "the box is 40 seconds
    deep, come back in 40" lets it decide.

    Both default to None so an ``AdmissionRejected(msg)`` raised anywhere else
    (test doubles included) stays valid — every reader must use ``payload()``
    or getattr defaults.
    """

    def __init__(self, message: str, predicted_wait_s: Optional[float] = None,
                 retry_after_s: Optional[float] = None,
                 reason: str = "queue_full"):
        super().__init__(message)
        self.predicted_wait_s = predicted_wait_s
        self.retry_after_s = retry_after_s
        self.reason = reason

    def payload(self) -> dict:
        """The refusal, JSON-shaped, for the 429 body."""
        return {"reason": self.reason,
                "predicted_wait_s": self.predicted_wait_s,
                "retry_after_s": self.retry_after_s}


class ShuttingDown(Exception):
    """Raised when a submit arrives (or a queued job is drained) during
    graceful shutdown — maps to HTTP 503."""


class EngineStartupError(RuntimeError):
    """A worker failed — or timed out — loading its model.

    Raised by ``TtsEngine.start()``, which the lifespan awaits, so the process
    exits non-zero with a real message instead of hanging forever with no port
    bound and no /health to explain itself."""


class TtsEngine:
    def __init__(self):
        # Process-global CPU tuning, applied before any worker (and therefore
        # any model) starts. Records what actually took effect for /metrics.
        self.tuning = _apply_cpu_tuning()
        self.metrics = Metrics()
        self._queue = _DeadlineQueue()
        # Sum of est_synth_s over jobs that are queued but not yet claimed —
        # the numerator of every predicted wait. Maintained at exactly two
        # points: submit adds, Job.claim's settle hook subtracts.
        self._pending_lock = threading.Lock()
        self._pending_est_s = 0.0
        # Reconciliation against the real queue (see _reconcile_pending): when
        # it last ran, and what the last correction was worth (surfaced on
        # config() so drift is visible instead of merely absent).
        self._pending_reconciled_at = 0.0
        self._pending_drift_s = 0.0
        # Admission slots = workers (in-flight) + queue_max (waiting).
        self._max_inflight = SETTINGS.workers + SETTINGS.queue_max
        self._admit = threading.Semaphore(self._max_inflight)
        self._stopping = False
        # Serializes the _stopping flip in stop() against the enqueue in submit()
        # so a job can't land on the queue AFTER the final drain sweep (which
        # would leave its future unresolved and leak an admission permit).
        self._enqueue_lock = threading.Lock()
        self._workers = [_Worker(i, self) for i in range(SETTINGS.workers)]
        # Serializes worker replacement (a dying worker runs _worker_exited on
        # its own thread, so two slots can die at once).
        self._supervise_lock = threading.Lock()
        # True once a slot has burned its restart budget: this replica can no
        # longer serve and says so on /health. Never un-set — giving up is a
        # terminal state a supervisor resolves by replacing the process.
        self._workers_failed = False

    def start(self):
        """Start every worker and block until each has finished LOADING.

        Raises ``EngineStartupError`` if any worker's model load failed or is
        still running after ``_MODEL_LOAD_TIMEOUT_S`` — a partially-loaded pool
        is a broken replica, and it must fail loudly at startup rather than
        serve from whatever happened to come up.
        """
        for w in self._workers:
            w.start()
        self._await_startup(self._workers)

    def _await_startup(self, workers: "list[_Worker]"):
        deadline = time.monotonic() + _MODEL_LOAD_TIMEOUT_S
        failures: list[str] = []
        cause: BaseException | None = None
        for w in workers:
            # Wait on startup_done (set on success AND on failure), never on
            # `ready` — the old `w.ready.wait()` with no timeout is exactly how
            # a load failure turned into a permanent silent hang.
            if not w.startup_done.wait(max(0.0, deadline - time.monotonic())):
                failures.append(f"worker {w.idx}: model still loading after "
                                f"{_MODEL_LOAD_TIMEOUT_S:.0f}s")
            elif w.load_error is not None:
                failures.append(f"worker {w.idx}: {w.load_error!r}")
                cause = cause or w.load_error
        if not failures:
            logger.info("engine ready: %d worker(s) loaded", len(workers))
            return
        msg = ("engine startup failed — %d of %d worker(s) unusable: %s"
               % (len(failures), len(workers), "; ".join(failures)))
        logger.critical(msg)
        self._workers_failed = True
        # Release whatever the half-started pool holds and stop the workers that
        # DID come up, so the process can exit instead of lingering with live
        # threads and a port nobody can be served from.
        try:
            self.stop(drain_timeout_s=1.0)
        except Exception:  # noqa: BLE001 - cleanup must not mask the real cause
            logger.exception("engine startup cleanup failed")
        raise EngineStartupError(msg) from cause

    def _worker_exited(self, worker: "_Worker", death: BaseException | None):
        """Called by a worker as it leaves ``run()``.

        An expected exit (graceful shutdown) is ignored. An unexpected one
        replaces the slot, up to ``_WORKER_RESTART_MAX`` times — after that the
        engine gives up VISIBLY (CRITICAL log + not-ready on /health) so the
        process supervisor replaces the replica instead of the engine hiding a
        deterministic crash loop behind an endless respawn.
        """
        if self._stopping:
            return
        with self._supervise_lock:
            if self._stopping or self._workers[worker.idx] is not worker:
                return  # already superseded
            if worker.generation >= _WORKER_RESTART_MAX:
                self._workers_failed = True
                logger.critical(
                    "tts worker %d died %d times; giving up. This replica has no "
                    "worker for slot %d — /health now reports not-ready so the "
                    "process supervisor can replace it.",
                    worker.idx, worker.generation + 1, worker.idx)
                return
            replacement = _Worker(worker.idx, self,
                                  generation=worker.generation + 1)
            self._workers[worker.idx] = replacement
            logger.error("tts worker %d died (%s); restarting it (attempt %d/%d)",
                         worker.idx,
                         type(death).__name__ if death is not None else "clean exit",
                         replacement.generation, _WORKER_RESTART_MAX)
        replacement.start()

    def stop(self, drain_timeout_s: float = 10.0):
        """Graceful drain shutdown.

        1. Stop accepting new submits (``submit`` now raises ``ShuttingDown``).
        2. Fail every QUEUED (not-yet-started) job fast with ``ShuttingDown`` —
           a restart shouldn't wait for a deep queue to synthesize. Jobs already
           inside ``generate_audio`` finish on their own (the call is atomic).
        3. Wake the workers and join them within ``drain_timeout_s``.

        Every pending future is resolved (result or exception) before this
        returns, so no caller hangs waiting on the request timeout.
        """
        # Flip the flag under the enqueue lock so it is ordered against submit():
        # either submit enqueues before we stop (the drain below resolves it), or
        # it sees _stopping under the lock and refuses cleanly. No job can slip
        # onto the queue after the final drain sweep.
        with self._enqueue_lock:
            self._stopping = True
        # Fail queued jobs before we hand out sentinels so callers unblock now.
        self._drain_queue()
        for _ in self._workers:
            self._queue.put(None)  # unblock any worker parked in queue.get
        deadline = time.monotonic() + drain_timeout_s
        for w in list(self._workers):
            # `is_alive()` first: a slot may hold a REPLACEMENT worker created
            # by _worker_exited but not yet started (it is started outside the
            # supervise lock), and joining an unstarted thread raises. Such a
            # worker sees _stopping and exits on its first loop check anyway.
            if not w.is_alive():
                continue
            w.join(timeout=max(0.0, deadline - time.monotonic()))
        # An in-flight job that finished during the join may have let its worker
        # loop once more and dequeue nothing (it exits on _stopping); but a job
        # could also have raced onto the queue between the first drain and the
        # sentinels. Sweep once more so nothing is left unresolved.
        self._drain_queue()

    def _drain_queue(self):
        """Resolve every still-queued job with a ShuttingDown error and release
        its admission permit. Idempotent; safe to call repeatedly."""
        while True:
            try:
                job = self._queue.get_nowait()
            except queue.Empty:
                break
            if job is None:  # a shutdown sentinel — nothing to resolve
                self._queue.task_done()
                continue
            if not job.claim():
                # Already settled by the abandon hook (permit released, future
                # cancelled) or by a worker: a tombstone, nothing to drain.
                self._queue.task_done()
                continue
            if not job.future.done():
                job.future.set_exception(ShuttingDown("server shutting down"))
            self.metrics.on_drain()
            self._admit.release()
            self._queue.task_done()

    def _release_abandoned(self, job: "Job") -> None:
        """Hook fired by ``job.abandoned.set()`` (504 timeout / disconnect).

        Frees the admission permit AT THE MOMENT the caller gives up instead of
        whenever a worker finally dequeues the job — a disconnected client stops
        costing capacity immediately. The job stays in the queue as a tombstone
        that the next worker discards (see ``_Worker._serve_once``).

        Safe to call any number of times, and safe to race a worker or the
        drain: the claim decides the single owner, and a caller that loses it
        does nothing.
        """
        if not job.claim():
            return  # already running, drained, or already abandoned
        self.metrics.on_abandoned()
        job.future.cancel()
        self._admit.release()

    @property
    def live_workers(self) -> int:
        """Workers that are BOTH alive and loaded — real serving capacity.

        Read from the threads themselves, not from a one-time startup flag: a
        worker that died mid-loop must stop counting immediately, or the replica
        keeps answering /health with 200 while every request queues behind
        nobody and eventually 429s."""
        return sum(1 for w in self._workers if w.is_alive() and w.ready.is_set())

    @property
    def worker_count(self) -> int:
        return len(self._workers)

    @property
    def failed(self) -> bool:
        """True once a worker slot burned its restart budget: terminal."""
        return self._workers_failed

    @property
    def ready(self) -> bool:
        return (not self._workers_failed
                and bool(self._workers)
                and self.live_workers == len(self._workers))

    @property
    def draining(self) -> bool:
        """True once graceful shutdown began: submits are refused with 503.

        Public so /health can fail readiness during the drain — a pod that
        still reports ready keeps receiving traffic it will only reject.
        """
        return self._stopping

    def available_permits(self) -> int:
        """Admission permits currently free (max_inflight when fully idle).

        Public accessor so callers/tests don't reach into threading.Semaphore's
        private `_value`, which is an undocumented CPython detail that a stdlib
        change — or swapping in a BoundedSemaphore — would silently break.
        """
        return self._admit._value

    def voice_lru_keys(self) -> list[str]:
        """Voice ids currently resident in some worker's LRU (read-only).

        Fabric's router uses this for affinity: routing to a replica that
        already holds the voice skips get_state_for_audio_prompt, the largest
        avoidable cost on a cold voice.

        Called from ANOTHER THREAD (the replica's admin server) while the
        workers are serving, so each worker hands back its own copy taken under
        its own lock — never the live view, which is what used to raise
        "dictionary changed size during iteration" precisely when the box was
        busy enough for affinity to matter. Still advisory: the answer is a
        snapshot of a set of snapshots, and a voice can be evicted a moment
        after it is reported.
        """
        keys: set[str] = set()
        for w in self._workers:
            keys.update(w.voice_cache_keys())
        return sorted(keys)

    # -- the deadline contract --------------------------------------------
    def _settle_job(self, job: "Job") -> None:
        """A job left the queue (claimed to run, abandoned or drained): stop
        counting its estimated cost against everyone still waiting."""
        with self._pending_lock:
            self._pending_est_s = max(0.0, self._pending_est_s - job.est_synth_s)

    def _reconcile_pending(self, force: bool = False) -> float:
        """Re-derive ``_pending_est_s`` from the queue itself. Returns the total.

        ``_pending_est_s`` is the numerator of every predicted wait and every
        promise, and it was increment/decrement only: submit added, the settle
        hook subtracted, and NOTHING ever checked the result against reality.
        The settle hook is explicitly best-effort (``Job.claim`` swallows its
        failures rather than lose a job), so drift was not hypothetical, and a
        drifted numerator quietly poisons every number downstream of it.

        Event-driven and rate-limited rather than a background sweeper: this
        runs on the submit path (through ``predicted_wait_s``) at most once per
        ``_PENDING_RECONCILE_S``, and costs one walk of a heap bounded by
        ``workers + queue_max``. No new thread, no new lock — and note it is
        ``_pending_lock``, NOT ``Metrics._lock``, so metrics hold times are
        untouched.

        The walk happens WHILE ``_pending_lock`` is held, which is what makes it
        exact rather than a race: a settle that lands mid-reconcile blocks until
        the fresh total is stored and then subtracts from it, instead of being
        overwritten by a snapshot that still counted its job.
        """
        now = time.monotonic()
        with self._pending_lock:
            if not force and (now - self._pending_reconciled_at
                              < _PENDING_RECONCILE_S):
                return self._pending_est_s
            truth = self._queue.pending_est_s()
            self._pending_drift_s = round(truth - self._pending_est_s, 6)
            self._pending_est_s = truth
            self._pending_reconciled_at = now
            return truth

    def pending_cost_s(self) -> float:
        """Estimated synthesis seconds sitting in the queue right now."""
        return round(self._reconcile_pending(), 3)

    def predicted_wait_s(self, est_synth_s: float = 0.0) -> float:
        """How long a job costing ``est_synth_s`` would take to come back.

        Queued work ahead of it, spread over the workers that are actually
        alive, plus its own render. ``live_workers`` and not ``worker_count``:
        promising against capacity that died is exactly the lie this whole
        contract exists to stop telling.
        """
        workers = max(1, self.live_workers or self.worker_count)
        return round(self.pending_cost_s() / workers + max(0.0, est_synth_s), 3)

    @staticmethod
    def _deadline_floor_s(job_class: str) -> float:
        """The tightest queue-key horizon an explicit deadline may buy, by class.

        THIS is the mechanism that stops ``deadline_s`` being a free priority
        escalation from an unauthenticated request body — see
        ``_INTERACTIVE_DEADLINE_FLOOR_S`` for the full argument. Bulk floors at
        the interactive horizon (tie at best, never outrank); interactive floors
        at a small non-zero value (tighten within the class, never to zero).
        """
        return (_INTERACTIVE_DEADLINE_FLOOR_S if job_class == CLASS_INTERACTIVE
                else _INTERACTIVE_HORIZON_S)

    @staticmethod
    def _priority(job: "Job") -> float:
        """The queue key: the wall-clock instant this job wants to be done by.

        An explicit ``deadline_s`` is that instant directly — FLOORED at its
        class's minimum horizon (``_deadline_floor_s``) so that a caller cannot
        buy its way past the interactive class, or past the aging bound, by
        naming an absurdly tight deadline. Otherwise the job gets its class's
        horizon, which is what makes interactive work jump the queue AND makes
        that jump bounded: bulk work enqueued more than (BULK - INTERACTIVE)
        seconds ago already has the earlier key, so it cannot be starved by an
        endless stream of interactive arrivals.
        """
        if job.deadline_s is not None:
            floor = TtsEngine._deadline_floor_s(job.job_class)
            return job.t_enqueue + max(floor, float(job.deadline_s))
        horizon = (_INTERACTIVE_HORIZON_S if job.job_class == CLASS_INTERACTIVE
                   else _BULK_AGING_HORIZON_S)
        return job.t_enqueue + horizon

    @staticmethod
    def _degrade(job: "Job", predicted_wait_s: float,
                 fractions: "Optional[dict[str, tuple[Optional[float], str]]]" = None
                 ) -> bool:
        """Fit ``job`` into its deadline by rendering it more cheaply.

        Walks the quality ladder for the FIRST rung whose cost lands inside the
        deadline, applies that level's decode knobs through the existing
        ``Job.overrides`` seam and STAMPS the level on the job. Never lowers a
        knob the caller already pinned lower, and never runs at all unless the
        caller allowed it — a cheaper render nobody asked for and nobody is told
        about is silent quality loss, which is worse than a refusal.

        WHEN NO RUNG FITS, NOTHING IS DEGRADED. The job is left untouched at
        full quality and this returns False. Walking to the bottom of the ladder
        anyway — what this used to do — handed the caller the cheapest audio AND
        a missed deadline: they paid for the degradation and got nothing for it.
        Failing at full quality is the honest outcome, and the miss is recorded
        (``Metrics.on_deadline_unfittable``) rather than papered over.

        ``fractions`` are MEASURED cost fractions (``Metrics.ladder_fractions``)
        when the engine has enough samples for a level; a level with no window
        falls back to the ladder's assumed constant, and the basis of whichever
        was used is stamped on ``job.degrade_basis`` so the promise layer can
        refuse to promise on a guess.
        """
        deadline = float(job.deadline_s)
        full_cost = job.est_synth_s
        for level, steps, frames, assumed in _QUALITY_LADDER:
            measured, basis = (fractions or {}).get(level, (None, "assumed"))
            fraction = assumed if measured is None else measured
            cost = round(full_cost * fraction, 3)
            if predicted_wait_s + cost > deadline:
                continue        # this rung does not fit either
            job.quality_level = level
            job.est_synth_s = cost
            job.degrade_basis = basis
            want_steps = job.overrides.get("lsd_decode_steps")
            if want_steps is None or want_steps > steps:
                job.overrides["lsd_decode_steps"] = steps
            if job.frames_after_eos is None or job.frames_after_eos > frames:
                job.frames_after_eos = frames
            return True         # go no cheaper than we must
        return False

    def submit(self, voice_id: str, text: str, overrides: Optional[dict] = None,
               max_tokens: Optional[int] = None,
               frames_after_eos: Optional[int] = None,
               deadline_s: Optional[float] = None,
               job_class: str = CLASS_BULK,
               degrade_allowed: bool = False) -> Job:
        """Admit a job or raise AdmissionRejected (429). Non-blocking admission.

        Once graceful shutdown has begun, refuses new work with ShuttingDown
        (503) so a draining process doesn't admit jobs it will only fail.

        ``deadline_s`` (seconds from now), ``job_class`` and ``degrade_allowed``
        are the deadline contract. Leaving all three alone is the pre-deadline
        engine, byte for byte: bulk class, arrival-ordered, full quality, no
        reserved floor (the floor defaults to 0 permits).

        A refusal now carries ``predicted_wait_s`` and ``retry_after_s`` — what
        the caller would have waited, and when to come back.
        """
        if self._stopping:
            raise ShuttingDown("server shutting down")
        if job_class not in _CLASSES:
            raise ValueError(f"unknown admission class {job_class!r} "
                             f"(expected one of {_CLASSES})")
        self.metrics.on_received()
        max_tokens = max_tokens or SETTINGS.max_tokens
        cost = self.metrics.cost_estimate(len(text or ""), max_tokens)
        est_synth_s = cost["est_synth_s"]
        # TWO different numbers, and conflating them was double-counting this
        # job's own render:
        #   queue_wait — how long until a worker picks THIS job up;
        #   predicted  — the caller's whole round trip, queue_wait + its render.
        # `predicted` is what a refusal reports (what you would have waited);
        # `queue_wait` is what the deadline arithmetic below adds the render to.
        # Using `predicted` there charged the render twice, which inflated every
        # promise — invisible until promises started being measured, and a
        # promise inflated by its own cost is a hit rate that means nothing.
        queue_wait = self.predicted_wait_s()
        predicted = self.predicted_wait_s(est_synth_s)
        if not self._admit.acquire(blocking=False):
            self.metrics.on_rejected()
            raise AdmissionRejected(
                f"queue full (max in-flight {self._max_inflight})",
                predicted_wait_s=predicted,
                retry_after_s=self._retry_after(predicted),
            )
        # The interactive floor: bulk work may not consume the last
        # _INTERACTIVE_RESERVE permits. Checked AFTER the acquire so the number
        # we read is the number that would remain — a bulk job that would dip
        # the pool below the floor hands its permit straight back.
        if (job_class != CLASS_INTERACTIVE and _INTERACTIVE_RESERVE > 0
                and self.available_permits() < _INTERACTIVE_RESERVE):
            self._admit.release()
            self.metrics.on_rejected()
            raise AdmissionRejected(
                f"bulk admission is holding {_INTERACTIVE_RESERVE} permit(s) "
                f"back for interactive work",
                predicted_wait_s=predicted,
                retry_after_s=self._retry_after(predicted),
                reason="interactive_reserve",
            )
        job = Job(
            voice_id=voice_id, text=text, overrides=dict(overrides or {}),
            max_tokens=max_tokens,
            frames_after_eos=frames_after_eos,
            deadline_s=deadline_s, job_class=job_class,
            degrade_allowed=degrade_allowed, est_synth_s=est_synth_s,
        )
        # Elastic quality: a slightly cheaper render that lands on time beats a
        # perfect one that misses (or 429s). Opt-in, and always reported. When
        # NO rung fits, nothing is degraded — the job runs at full quality and
        # the unmeetable deadline is recorded (see _degrade).
        if (deadline_s is not None
                and queue_wait + est_synth_s > float(deadline_s)):
            fitted = (degrade_allowed
                      and self._degrade(job, queue_wait,
                                        self.metrics.ladder_fractions()))
            if not fitted:
                self.metrics.on_deadline_unfittable()
        # Promise ONLY from a warm window (Metrics.cost_estimate decides): an
        # estimate off a two-sample window is a number, not a contract. And
        # only from a CALIBRATED basis: a degraded job's cost rests on the
        # ladder fraction, which is an invented constant until this engine has
        # measured the level for itself, so promising off it would stamp a
        # header that is 30-50% guess with the same authority as a measured
        # one. Withheld, not widened — the caller gets no number rather than a
        # number they cannot rely on.
        if cost["promise"] and job.degrade_basis in (None, "measured"):
            job.promised_s = round(queue_wait + job.est_synth_s, 3)
        # Wired BEFORE the job is reachable by anyone else, so there is no
        # window in which abandoning it would silently keep the permit.
        job.abandoned._on_abandon = functools.partial(self._release_abandoned, job)
        job.settle_hook = functools.partial(self._settle_job, job)
        # Re-check _stopping while enqueuing so this can't race the shutdown
        # drain: if stop() won the flag, release the permit and refuse cleanly
        # instead of putting a job no worker will ever dequeue.
        with self._enqueue_lock:
            if self._stopping:
                self._admit.release()
                raise ShuttingDown("server shutting down")
            with self._pending_lock:
                self._pending_est_s += job.est_synth_s
            self.metrics.on_enqueue()
            self._queue.put(job, self._priority(job))
        return job

    @staticmethod
    def _retry_after(predicted_wait_s: float) -> float:
        """A backoff hint the caller can act on: the wait we just predicted,
        floored at one second (a 429 that says "retry in 0s" is a hot loop) and
        rounded up, because coming back slightly late costs nothing and coming
        back early costs another 429."""
        return float(max(1, math.ceil(predicted_wait_s)))

    def config(self) -> dict:
        return {
            "workers": SETTINGS.workers,
            "queue_max": SETTINGS.queue_max,
            "max_in_flight": self._max_inflight,
            "torch_threads": SETTINGS.torch_threads,
            "language": SETTINGS.language,
            "quantize": SETTINGS.quantize,
            "ffmpeg_threads": SETTINGS.ffmpeg_threads,
            # The deadline contract's knobs, so an operator can see which
            # scheduling policy this replica is actually running.
            "scheduling": {
                "interactive_reserve": _INTERACTIVE_RESERVE,
                "bulk_aging_horizon_s": _BULK_AGING_HORIZON_S,
                "interactive_horizon_s": _INTERACTIVE_HORIZON_S,
                "interactive_deadline_floor_s": _INTERACTIVE_DEADLINE_FLOOR_S,
                "cost_warm_window": _WARM_WINDOW,
                "ladder_warm_window": _LADDER_WARM_WINDOW,
                "pending_reconcile_s": _PENDING_RECONCILE_S,
                # What the last reconciliation had to correct. A number that
                # stays at 0.0 is the accounting agreeing with the queue; a
                # number that does not is the drift this exists to catch.
                "pending_drift_s": self._pending_drift_s,
            },
            # What the CPU tuning ACTUALLY achieved (not what was requested):
            # set_flush_denormal can refuse, interop threads can be too late,
            # and inference_mode demotes itself on incompatibility. The A/B
            # script reads this back to label each run honestly.
            "tuning": dict(self.tuning, inference_mode=_INFERENCE_MODE_OK),
        }
