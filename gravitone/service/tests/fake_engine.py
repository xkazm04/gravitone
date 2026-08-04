"""Import-time dependency shims + a deterministic fake worker pool.

Importing this module BEFORE ``service.app`` injects fake ``torch``, ``scipy``
and ``pocket_tts`` modules into ``sys.modules`` (none of which are installed on
the build box), so the app and engine import without the real model stack. It
also exposes :class:`FakeEngine`, a drop-in for ``service.app.ENGINE`` that
mocks synthesis at the engine boundary — no model, just timed fake audio.
"""
from __future__ import annotations

import io
import itertools
import queue
import sys
import threading
import time
import traceback
import types
import wave
from concurrent.futures import Future


# ---------------------------------------------------------------------------
# 1) Shim the uninstalled native deps so `import service.engine` succeeds.
# ---------------------------------------------------------------------------
def _install_shims() -> None:
    if "torch" not in sys.modules:
        torch = types.ModuleType("torch")
        # Thread/CPU tuning surface used by engine._apply_cpu_tuning. The
        # setters record into `torch._tuning` so tests can assert the engine
        # asked for what config said, and the getters read it back — the same
        # "what actually took effect" contract the real torch has.
        torch._tuning = {"threads": None, "interop": None, "flush_denormal": None}

        def _set_threads(n):
            torch._tuning["threads"] = n

        def _set_interop(n):
            torch._tuning["interop"] = n

        def _set_flush_denormal(on):
            torch._tuning["flush_denormal"] = bool(on)
            return True

        torch.set_num_threads = _set_threads
        torch.get_num_threads = lambda: torch._tuning["threads"] or 0
        torch.set_num_interop_threads = _set_interop
        torch.get_num_interop_threads = lambda: torch._tuning["interop"] or 0
        torch.set_flush_denormal = _set_flush_denormal
        backends = types.ModuleType("torch.backends")
        quantized = types.ModuleType("torch.backends.quantized")
        quantized.engine = "none"
        quantized.supported_engines = ["none", "qnnpack"]
        backends.quantized = quantized
        torch.backends = backends
        sys.modules["torch.backends"] = backends
        sys.modules["torch.backends.quantized"] = quantized

        # inference_mode / no_grad — real context managers so the engine's
        # grad-free wrapper (and its fallback) can be exercised without torch.
        class _NullCtx:
            def __init__(self, name):
                self.name = name

            def __enter__(self):
                torch._tuning["entered"] = self.name
                return self

            def __exit__(self, *exc):
                return False

        torch.inference_mode = lambda: _NullCtx("inference_mode")
        torch.no_grad = lambda: _NullCtx("no_grad")
        torch.Tensor = object
        sys.modules["torch"] = torch
    if "scipy" not in sys.modules:
        scipy = types.ModuleType("scipy")
        scipy_io = types.ModuleType("scipy.io")
        wavfile = types.ModuleType("scipy.io.wavfile")
        wavfile.write = lambda *a, **k: None
        scipy_io.wavfile = wavfile
        scipy.io = scipy_io
        # scipy.signal.resample_poly — real scipy isn't installed here, so we
        # shim a deterministic stand-in that RECORDS its (len, up, down) calls
        # on `resample_poly.calls` and returns the input unchanged. Tests assert
        # the engine helper derives the right up/down factors (e.g. 24000->16000
        # => up=2, down=3) without needing real DSP.
        scipy_signal = types.ModuleType("scipy.signal")

        def _fake_resample_poly(x, up, down, **kwargs):
            _fake_resample_poly.calls.append((len(x), int(up), int(down)))
            return x

        _fake_resample_poly.calls = []
        scipy_signal.resample_poly = _fake_resample_poly
        scipy.signal = scipy_signal
        sys.modules["scipy"] = scipy
        sys.modules["scipy.io"] = scipy_io
        sys.modules["scipy.io.wavfile"] = wavfile
        sys.modules["scipy.signal"] = scipy_signal
    if "pocket_tts" not in sys.modules:
        pocket = types.ModuleType("pocket_tts")
        pocket.TTSModel = object
        sys.modules["pocket_tts"] = pocket


_install_shims()

# Safe to import now that the shims are in place. `_AbandonFlag` is imported
# (not re-implemented) on purpose: the fake must abandon jobs the same way the
# real engine does, or an HTTP-level test proves nothing about production.
from service.engine import (  # noqa: E402
    AdmissionRejected, SynthResult, TtsEngine, _AbandonFlag,
)


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

    def __init__(self, engine: "FakeEngine | None" = None) -> None:
        self.timeouts = 0
        # Mirrors engine.Metrics: a cache-served request never reaches submit,
        # so the API layer counts it here. `received` must include them or it
        # stops meaning "requests this replica served".
        self.received = 0
        self.cache_hits = 0
        self.collapsed = 0
        self._engine = engine

    def counters(self) -> dict:
        # Report the LIVE counters. Hardcoded zeros made a busy engine
        # indistinguishable from an idle one, so any metrics assertion against
        # this fake was vacuous.
        eng = self._engine
        in_flight = eng._cur if eng is not None else 0
        queued = max(0, eng._admitted - eng._cur) if eng is not None else 0
        return {"in_flight": in_flight, "queued": queued, "timeouts": self.timeouts,
                "received": self.received, "cache_hits": self.cache_hits,
                "collapsed": self.collapsed}

    def snapshot(self) -> dict:
        # The real Metrics.snapshot is counters() plus percentiles; the 429 path
        # deliberately takes the cheap half, so the fake models both.
        return dict(self.counters(), latency_p50_s=None, window_size=0)

    def on_timeout(self) -> None:
        self.timeouts += 1

    def on_received(self) -> None:
        self.received += 1

    def on_cache_hit(self) -> None:
        self.received += 1
        self.cache_hits += 1

    def on_collapsed(self) -> None:
        self.received += 1
        self.collapsed += 1


class _FakeJob:
    __slots__ = ("future", "text", "voice_id", "abandoned",
                 "_claimed", "_claim_lock",
                 # The deadline contract, carried with the SAME names the real
                 # engine's Job uses — TtsEngine._priority is applied to these
                 # objects directly (see FakeEngine._key), so the fake orders
                 # its queue by the production rule instead of a copy of it.
                 "deadline_s", "job_class", "t_enqueue", "degrade_allowed",
                 "quality_level", "promised_s", "predicted_wait_s", "_work")

    def __init__(self, future: Future, text: str, voice_id: str) -> None:
        self.future = future
        self.text = text
        self.voice_id = voice_id
        self.deadline_s = None
        self.job_class = "bulk"
        self.degrade_allowed = False
        self.t_enqueue = time.perf_counter()
        self.quality_level = "full"
        self.promised_s = None
        self.predicted_wait_s = 0.0
        # The real engine's Job carries this flag; the API layer sets it on a
        # 504/disconnect (app.py `_await_result`, `_abandon_all`) and setting it
        # releases the admission slot IMMEDIATELY via the engine hook.
        self.abandoned = _AbandonFlag()
        self._claimed = False
        self._claim_lock = threading.Lock()

    def claim(self) -> bool:
        """Same claim protocol as engine.Job: exactly one of {run, abandon}
        owns the slot and the future."""
        with self._claim_lock:
            if self._claimed:
                return False
            self._claimed = True
            return True


class FakeEngine:
    """Deterministic stand-in for ``TtsEngine``.

    ``submit`` returns immediately with a job whose future resolves after a
    per-segment delay, executed on a bounded pool of ``workers`` threads — so
    the engine's true parallelism ceiling (and thus concurrent occupancy) is
    faithfully modelled. ``capacity`` caps jobs IN FLIGHT; the next ``submit``
    raises ``AdmissionRejected`` (the 429 path). Like the real engine, the slot
    is released when the job finishes — so ``capacity`` is backpressure, not a
    lifetime quota.

    THE DEADLINE CONTRACT IS MODELLED, NOT JUST RECORDED. The pool is a
    PRIORITY queue keyed by ``engine.TtsEngine._priority`` — the production
    function, applied to the fake's jobs — so a tighter deadline really is
    served first here, and elastic quality really does shorten the render:
    ``submit`` walks the same ladder the engine walks and, like the engine,
    runs at FULL quality when no rung fits. That is what makes an HTTP-level
    test of "the caller's deadline reached the engine" an observation rather
    than a plumbing assertion: remove the wiring on a route and the ordering
    and the quality level both change back.

    ``paused=True`` holds every worker at the gate so a test can queue several
    jobs and then ``resume()`` to observe the order they are served in.

    Call ``close()`` when done (the test's tearDown) to shut the worker pool.
    """

    def __init__(self, workers: int = 2, delay: float = 0.15,
                 capacity: int = 1000, delays: dict[str, float] | None = None,
                 error: str | None = None,
                 errors: dict[str, str] | None = None,
                 paused: bool = False):
        self.metrics = _FakeMetrics(self)
        self.workers = workers
        self.delay = delay
        self.delays = delays or {}
        self.capacity = capacity
        self.error = error  # if set, the worker future raises RuntimeError(error)
        self.errors = errors or {}  # per-segment: {text: message} raises for that text only
        self.jobs: list[_FakeJob] = []  # every job ever submitted, in order
        self._lock = threading.Lock()
        self._admitted = 0
        self._cur = 0
        self.max_concurrent = 0
        self.submit_order: list[str] = []
        # Texts that a worker ACTUALLY ran (abandoned jobs never appear here).
        self.executed: list[str] = []
        # Texts whose deadline no ladder rung could meet: the engine's honest
        # answer is to run them at full quality and record the miss, and a test
        # needs to see that this route asked at all.
        self.unfittable: list[str] = []
        # The priority pool. A PriorityQueue of (key, seq, job) exactly like
        # engine._DeadlineQueue — the payload is never compared.
        self._q: "queue.PriorityQueue[tuple[float, int, _FakeJob | None]]" = \
            queue.PriorityQueue()
        self._seq = itertools.count()
        self._gate = threading.Event()
        if not paused:
            self._gate.set()
        self._threads = [threading.Thread(target=self._serve, daemon=True,
                                          name=f"fake-tts-{i}")
                         for i in range(workers)]
        for t in self._threads:
            t.start()

    # -- the priority pool ---------------------------------------------------
    @staticmethod
    def _key(job: "_FakeJob") -> float:
        """The production queue key, computed by the production function.

        ``TtsEngine._priority`` reads exactly ``t_enqueue``/``deadline_s``/
        ``job_class``, all of which ``_FakeJob`` carries, so the fake inherits
        the real class floors and the real aging term instead of a stale copy.
        """
        return TtsEngine._priority(job)

    def resume(self) -> None:
        """Let the paused workers start dequeuing."""
        self._gate.set()

    def _serve(self) -> None:
        self._gate.wait(30)
        while True:
            job = self._q.get()[2]
            if job is None:  # close() sentinel
                return
            try:
                job._work()
            except BaseException:  # noqa: BLE001 - a worker must not die
                # The real worker survives a failing job (engine._serve_once
                # handles it and carries on); a fake whose thread died here
                # would silently stop serving every LATER job in the test.
                traceback.print_exc()

    def _abandon(self, job: _FakeJob) -> None:
        """Mirror of ``TtsEngine._release_abandoned``: the caller gave up, so
        free the admission slot NOW and cancel the future. The claim makes
        double-release and double-run impossible; the job is left in the pool
        as a tombstone its worker discards."""
        if not job.claim():
            return  # already running or already abandoned
        job.future.cancel()
        with self._lock:
            self._admitted -= 1

    def submit(self, voice_id: str, text: str, overrides=None,
               max_tokens=None, frames_after_eos=None,
               deadline_s=None, job_class: str = "bulk",
               degrade_allowed: bool = False) -> _FakeJob:
        # Mirrors TtsEngine.submit: `received` is bumped for every request that
        # reaches the engine, admitted or rejected.
        self.metrics.on_received()
        delay = self.delays.get(text, self.delay)
        with self._lock:
            if self._admitted >= self.capacity:
                raise AdmissionRejected(
                    f"queue full (max in-flight {self.capacity})")
            self._admitted += 1
            self.submit_order.append(text)
            # What this job would wait for: the work admitted AHEAD of it,
            # spread over the pool. The real engine derives this from measured
            # cost (predicted_wait_s); the fake's cost is its delay.
            predicted = ((self._admitted - 1) * delay) / max(1, self.workers)
        future: Future = Future()
        job = _FakeJob(future, text, voice_id)
        job.deadline_s = deadline_s
        job.job_class = job_class
        job.degrade_allowed = degrade_allowed
        job.predicted_wait_s = round(predicted, 6)
        job.abandoned._on_abandon = lambda: self._abandon(job)
        if deadline_s is not None:
            delay = self._apply_deadline(job, delay)

        def _work() -> None:
            if not job.claim():
                return  # tombstone: abandoned before a worker reached it
            if job.abandoned.is_set():
                # Abandoned after we claimed it: skip the synthesis and hand the
                # slot back, exactly as the real worker loop does.
                job.future.cancel()
                with self._lock:
                    self._admitted -= 1
                return
            self.executed.append(text)
            with self._lock:
                self._cur += 1
                self.max_concurrent = max(self.max_concurrent, self._cur)
            try:
                time.sleep(delay)
                if self.error is not None:
                    raise RuntimeError(self.error)
                if text in self.errors:
                    raise RuntimeError(self.errors[text])
                marker = (len(self.submit_order) + hash(text)) & 0x7FFF
                if not future.cancelled():
                    # Cancelled from the OUTSIDE: asyncio.wrap_future cancels
                    # the underlying concurrent future when the awaiting task
                    # is cancelled (a client disconnect), and resolving a
                    # cancelled future raises InvalidStateError.
                    future.set_result(SynthResult(
                        wav_bytes=make_wav(marker),
                        sample_rate=24000, audio_seconds=1.0,
                        synth_seconds=delay, queue_seconds=0.0,
                    ))
            except Exception as exc:  # pragma: no cover - defensive
                if not future.cancelled():
                    future.set_exception(exc)
            finally:
                with self._lock:
                    self._cur -= 1
                    # Release the admission slot, mirroring the real engine
                    # (TtsEngine releases its semaphore permit on completion).
                    # Without this, `capacity` was a LIFETIME counter: N jobs
                    # submitted SEQUENTIALLY — each fully completing — still
                    # 429'd on N+1, so any backpressure test written against
                    # this fake asserted a contract the real engine doesn't have.
                    self._admitted -= 1

        job._work = _work
        self._q.put((self._key(job), next(self._seq), job))
        self.jobs.append(job)
        return job

    def _apply_deadline(self, job: "_FakeJob", delay: float) -> float:
        """The elastic-quality decision, modelled the way the engine makes it.

        Walks the same ladder fractions, takes the FIRST rung that fits, and —
        like ``TtsEngine._degrade`` — leaves the job at FULL quality when NO
        rung fits (recording it in ``unfittable``): the honest outcome for an
        unmeetable deadline is full quality plus a recorded miss, not the
        cheapest audio AND a missed deadline. Returns the delay to render with.
        """
        deadline = float(job.deadline_s)
        if job.predicted_wait_s + delay <= deadline:
            job.promised_s = round(job.predicted_wait_s + delay, 3)
            return delay                      # fits at full quality
        if job.degrade_allowed:
            for level, fraction in (("reduced", 0.7), ("minimal", 0.5)):
                if job.predicted_wait_s + delay * fraction <= deadline:
                    job.quality_level = level
                    delay = delay * fraction
                    job.promised_s = round(job.predicted_wait_s + delay, 3)
                    return delay
        self.unfittable.append(job.text)
        job.promised_s = round(job.predicted_wait_s + delay, 3)
        return delay

    def close(self) -> None:
        """Shut the worker pool. Tests must call this in tearDown — otherwise
        every FakeEngine leaks its worker threads for the run's lifetime."""
        self._gate.set()
        for _ in self._threads:
            # +inf: the sentinel must sit at the TAIL, exactly as it does in
            # engine._DeadlineQueue, or a worker would stop while real jobs wait.
            self._q.put((float("inf"), next(self._seq), None))

    def config(self) -> dict:
        return {"workers": self.workers}
