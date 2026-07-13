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
import queue
import subprocess
import threading
import time
import wave
from collections import deque
from concurrent.futures import Future
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import scipy.io.wavfile
import torch

from service.config import SETTINGS


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


def wav_bytes_to_mp3(wav_bytes: bytes, bitrate: str = "128k") -> bytes:
    """Transcode WAV -> MP3 via ffmpeg (must be on PATH). ElevenLabs default
    is MP3; we keep WAV as the fast path and encode MP3 only on request."""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-i", "pipe:0", "-f", "mp3", "-b:a", bitrate, "pipe:1"],
        input=wav_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg mp3 encode failed: {proc.stderr.decode(errors='ignore')[:300]}")
    return proc.stdout


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


@dataclass
class SynthResult:
    wav_bytes: bytes
    sample_rate: int
    audio_seconds: float
    synth_seconds: float
    queue_seconds: float


class _Worker(threading.Thread):
    def __init__(self, idx: int, engine: "TtsEngine"):
        super().__init__(name=f"tts-worker-{idx}", daemon=True)
        self.idx = idx
        self.engine = engine
        self.model = None
        self._voice_cache: dict[str, dict] = {}
        self.ready = threading.Event()

    # -- voice loading (per-instance; states are model-specific) -----------
    def _voice_state(self, voice_id: str) -> dict:
        st = self._voice_cache.get(voice_id)
        if st is not None:
            return st
        # 1) exported embedding in the voices dir, 2) a raw path, 3) a builtin name
        cand = Path(SETTINGS.voices_dir) / f"{voice_id}.safetensors"
        source = str(cand) if cand.is_file() else voice_id
        st = self.model.get_state_for_audio_prompt(source, truncate=True)
        self._voice_cache[voice_id] = st
        return st

    def run(self):
        from pocket_tts import TTSModel  # imported in-thread to avoid fork issues
        self.model = TTSModel.load_model(
            language=SETTINGS.language, quantize=SETTINGS.quantize
        )
        # Warm the default voice so the first real request isn't cold.
        try:
            self._voice_state(SETTINGS.default_voice)
        except Exception:  # noqa: BLE001 - default warmup is best-effort
            pass
        self.ready.set()

        while not self.engine._stopping:
            try:
                job: Job = self.engine._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if job is None:  # shutdown sentinel
                break
            self.engine.metrics.on_start()
            t_start = time.perf_counter()
            prev: dict = {}
            try:
                state = self._voice_state(job.voice_id)
                # apply expression overrides, remembering the originals
                for k, v in job.overrides.items():
                    prev[k] = getattr(self.model, k)
                    setattr(self.model, k, v)
                audio = self.model.generate_audio(
                    state, job.text,
                    max_tokens=job.max_tokens,
                    frames_after_eos=job.frames_after_eos,
                    copy_state=True,  # reuse the cached voice state safely
                )
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
            except Exception as exc:  # noqa: BLE001 - surface to caller
                self.engine.metrics.on_error()
                job.future.set_exception(exc)
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


class TtsEngine:
    def __init__(self):
        torch.set_num_threads(SETTINGS.torch_threads)
        self.metrics = Metrics()
        self._queue: "queue.Queue[Optional[Job]]" = queue.Queue()
        # Admission slots = workers (in-flight) + queue_max (waiting).
        self._max_inflight = SETTINGS.workers + SETTINGS.queue_max
        self._admit = threading.Semaphore(self._max_inflight)
        self._stopping = False
        self._workers = [_Worker(i, self) for i in range(SETTINGS.workers)]

    def start(self):
        for w in self._workers:
            w.start()
        for w in self._workers:
            w.ready.wait()  # block until every model instance is loaded

    def stop(self):
        self._stopping = True
        for _ in self._workers:
            self._queue.put(None)

    @property
    def ready(self) -> bool:
        return all(w.ready.is_set() for w in self._workers)

    def submit(self, voice_id: str, text: str, overrides: Optional[dict] = None,
               max_tokens: Optional[int] = None,
               frames_after_eos: Optional[int] = None) -> Job:
        """Admit a job or raise AdmissionRejected (429). Non-blocking admission."""
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
        }
