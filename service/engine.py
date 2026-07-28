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

import io
import logging
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
        self.in_flight = 0    # currently inside generate()
        self.queued = 0       # admitted but not yet being processed
        self._latencies: deque[float] = deque(maxlen=window)   # end-to-end seconds
        self._proc: deque[float] = deque(maxlen=window)        # pure synth seconds
        self._audio: deque[float] = deque(maxlen=window)       # audio seconds produced
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

    def on_abandoned(self):
        # A queued job the caller already gave up on (504/disconnect): it was
        # admitted (queued++) but never started (no on_start), so undo the
        # queue count and tally it as abandoned rather than errored/completed.
        with self._lock:
            self.queued -= 1
            self.abandoned += 1

    def on_drain(self):
        # A queued job failed fast during graceful shutdown: undo its queue
        # count. Kept distinct from on_abandoned (no counter bump) — draining is
        # an operator action, not caller behaviour.
        with self._lock:
            self.queued -= 1

    def on_enqueue(self):
        with self._lock:
            self.queued += 1

    def on_start(self):
        with self._lock:
            self.queued -= 1
            self.in_flight += 1

    def on_finish(self, latency_s: float, proc_s: float, audio_s: float):
        with self._lock:
            self.in_flight -= 1
            self.completed += 1
            self._latencies.append(latency_s)
            self._proc.append(proc_s)
            self._audio.append(audio_s)
            self.audio_seconds_total += audio_s

    def on_error(self):
        with self._lock:
            self.in_flight -= 1
            self.errored += 1

    @staticmethod
    def _pct(data, p):
        if not data:
            return None
        s = sorted(data)
        k = min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1))))
        return round(s[k], 4)

    def snapshot(self) -> dict:
        with self._lock:
            lat = list(self._latencies)
            proc = list(self._proc)
            audio = list(self._audio)
            base = {
                "received": self.received,
                "completed": self.completed,
                "rejected_429": self.rejected,
                "errored": self.errored,
                "timeouts": self.timeouts,
                "abandoned": self.abandoned,
                "in_flight": self.in_flight,
                "queued": self.queued,
                "audio_seconds_total": round(self.audio_seconds_total, 2),
            }
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
        })
        return base


# ----------------------------------------------------------------------------
# Job + worker
# ----------------------------------------------------------------------------
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
    # Set by the API layer when the caller has given up (504 timeout or client
    # disconnect). The worker checks this BEFORE starting synthesis and skips
    # the job if set — no wasted generation, permit released immediately. There
    # is no mid-generation cancellation: generate_audio is a single atomic C/
    # torch call with no cooperative cancel point, so a job already inside the
    # model runs to completion; only jobs still queued can be skipped.
    abandoned: threading.Event = field(default_factory=threading.Event)


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
        st = self._voice_cache.get(voice_id)
        if st is not None:
            self._voice_cache.move_to_end(voice_id)  # mark most-recently-used
            return st
        # 1) exported embedding in the voices dir, 2) a raw path, 3) a builtin name
        cand = Path(SETTINGS.voices_dir) / f"{voice_id}.safetensors"
        source = str(cand) if cand.is_file() else voice_id
        st = self.model.get_state_for_audio_prompt(source, truncate=True)
        self._voice_cache[voice_id] = st
        self._voice_cache.move_to_end(voice_id)
        if len(self._voice_cache) > _VOICE_CACHE_MAX:
            self._voice_cache.popitem(last=False)  # evict least-recently-used
        return st

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
        if job.abandoned.is_set():
            # Caller already gave up (504/disconnect): skip synthesis
            # entirely rather than burn a full generation on a result no
            # one will read. Release the admission permit immediately and
            # resolve the future as cancelled (not errored).
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
        self.engine.metrics.on_start()
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
    """Raised when the queue is full — maps to HTTP 429."""


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
        self._queue: "queue.Queue[Optional[Job]]" = queue.Queue()
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
            if not job.future.done():
                job.future.set_exception(ShuttingDown("server shutting down"))
            self.metrics.on_drain()
            self._admit.release()
            self._queue.task_done()

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

    def submit(self, voice_id: str, text: str, overrides: Optional[dict] = None,
               max_tokens: Optional[int] = None,
               frames_after_eos: Optional[int] = None) -> Job:
        """Admit a job or raise AdmissionRejected (429). Non-blocking admission.

        Once graceful shutdown has begun, refuses new work with ShuttingDown
        (503) so a draining process doesn't admit jobs it will only fail."""
        if self._stopping:
            raise ShuttingDown("server shutting down")
        self.metrics.on_received()
        if not self._admit.acquire(blocking=False):
            self.metrics.on_rejected()
            raise AdmissionRejected(
                f"queue full (max in-flight {self._max_inflight})"
            )
        job = Job(
            voice_id=voice_id, text=text, overrides=overrides or {},
            max_tokens=max_tokens or SETTINGS.max_tokens,
            frames_after_eos=frames_after_eos,
        )
        # Re-check _stopping while enqueuing so this can't race the shutdown
        # drain: if stop() won the flag, release the permit and refuse cleanly
        # instead of putting a job no worker will ever dequeue.
        with self._enqueue_lock:
            if self._stopping:
                self._admit.release()
                raise ShuttingDown("server shutting down")
            self.metrics.on_enqueue()
            self._queue.put(job)
        return job

    def config(self) -> dict:
        return {
            "workers": SETTINGS.workers,
            "queue_max": SETTINGS.queue_max,
            "max_in_flight": self._max_inflight,
            "torch_threads": SETTINGS.torch_threads,
            "language": SETTINGS.language,
            "quantize": SETTINGS.quantize,
            "ffmpeg_threads": SETTINGS.ffmpeg_threads,
            # What the CPU tuning ACTUALLY achieved (not what was requested):
            # set_flush_denormal can refuse, interop threads can be too late,
            # and inference_mode demotes itself on incompatibility. The A/B
            # script reads this back to label each run honestly.
            "tuning": dict(self.tuning, inference_mode=_INFERENCE_MODE_OK),
        }
