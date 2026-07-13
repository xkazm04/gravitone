"""Import-time dependency shims + a deterministic fake worker pool.

Importing this module BEFORE ``service.app`` injects fake ``torch``, ``scipy``
and ``pocket_tts`` modules into ``sys.modules`` (none of which are installed on
the build box), so the app and engine import without the real model stack. It
also exposes :class:`FakeEngine`, a drop-in for ``service.app.ENGINE`` that
mocks synthesis at the engine boundary — no model, just timed fake audio.
"""
from __future__ import annotations

import io
import sys
import threading
import time
import types
import wave
from concurrent.futures import Future, ThreadPoolExecutor


# ---------------------------------------------------------------------------
# 1) Shim the uninstalled native deps so `import service.engine` succeeds.
# ---------------------------------------------------------------------------
def _install_shims() -> None:
    if "torch" not in sys.modules:
        torch = types.ModuleType("torch")
        torch.set_num_threads = lambda n: None
        torch.Tensor = object
        sys.modules["torch"] = torch
    if "scipy" not in sys.modules:
        scipy = types.ModuleType("scipy")
        scipy_io = types.ModuleType("scipy.io")
        wavfile = types.ModuleType("scipy.io.wavfile")
        wavfile.write = lambda *a, **k: None
        scipy_io.wavfile = wavfile
        scipy.io = scipy_io
        sys.modules["scipy"] = scipy
        sys.modules["scipy.io"] = scipy_io
        sys.modules["scipy.io.wavfile"] = wavfile
    if "pocket_tts" not in sys.modules:
        pocket = types.ModuleType("pocket_tts")
        pocket.TTSModel = object
        sys.modules["pocket_tts"] = pocket


_install_shims()

# Safe to import now that the shims are in place.
from service.engine import AdmissionRejected, SynthResult  # noqa: E402


def make_wav(marker: int, frames: int = 240, sample_rate: int = 24000) -> bytes:
    """A real, valid 24kHz mono 16-bit WAV whose samples all equal ``marker``.

    Real (not hand-rolled) so ``concat_wavs`` — which parses via the ``wave``
    module — accepts it, while the 44-byte header still matches the streaming
    route's ``[44:]`` slice. The constant sample lets tests assert ordering.
    """
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes((marker & 0xFFFF).to_bytes(2, "little") * frames)
    return buf.getvalue()


class _FakeMetrics:
    """Just enough surface for the backpressure/metrics responses."""

    def __init__(self) -> None:
        self.timeouts = 0

    def snapshot(self) -> dict:
        return {"in_flight": 0, "queued": 0, "timeouts": self.timeouts}

    def on_timeout(self) -> None:
        self.timeouts += 1


class _FakeJob:
    __slots__ = ("future", "text", "voice_id")

    def __init__(self, future: Future, text: str, voice_id: str) -> None:
        self.future = future
        self.text = text
        self.voice_id = voice_id


class FakeEngine:
    """Deterministic stand-in for ``TtsEngine``.

    ``submit`` returns immediately with a job whose future resolves after a
    per-segment delay, executed on a bounded pool of ``workers`` threads — so
    the engine's true parallelism ceiling (and thus concurrent occupancy) is
    faithfully modelled. ``capacity`` caps admitted jobs; the next ``submit``
    raises ``AdmissionRejected`` (the 429 path).
    """

    def __init__(self, workers: int = 2, delay: float = 0.15,
                 capacity: int = 1000, delays: dict[str, float] | None = None,
                 error: str | None = None):
        self.metrics = _FakeMetrics()
        self.workers = workers
        self.delay = delay
        self.delays = delays or {}
        self.capacity = capacity
        self.error = error  # if set, the worker future raises RuntimeError(error)
        self._pool = ThreadPoolExecutor(max_workers=workers)
        self._lock = threading.Lock()
        self._admitted = 0
        self._cur = 0
        self.max_concurrent = 0
        self.submit_order: list[str] = []

    def submit(self, voice_id: str, text: str, overrides=None,
               max_tokens=None, frames_after_eos=None) -> _FakeJob:
        with self._lock:
            if self._admitted >= self.capacity:
                raise AdmissionRejected(
                    f"queue full (max in-flight {self.capacity})")
            self._admitted += 1
            self.submit_order.append(text)
        future: Future = Future()
        delay = self.delays.get(text, self.delay)

        def _work() -> None:
            with self._lock:
                self._cur += 1
                self.max_concurrent = max(self.max_concurrent, self._cur)
            try:
                time.sleep(delay)
                if self.error is not None:
                    raise RuntimeError(self.error)
                marker = (len(self.submit_order) + hash(text)) & 0x7FFF
                future.set_result(SynthResult(
                    wav_bytes=make_wav(marker),
                    sample_rate=24000, audio_seconds=1.0,
                    synth_seconds=delay, queue_seconds=0.0,
                ))
            except Exception as exc:  # pragma: no cover - defensive
                future.set_exception(exc)
            finally:
                with self._lock:
                    self._cur -= 1

        self._pool.submit(_work)
        return _FakeJob(future, text, voice_id)

    def config(self) -> dict:
        return {"workers": self.workers}
