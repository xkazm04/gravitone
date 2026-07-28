"""A dead worker cannot silently take the service down.

Two total-outage paths, proved against the REAL ``TtsEngine`` (driven by fake,
gated pocket-tts models — never the real model):

* **Startup**: a model load that raises — or never returns — used to hang the
  lifespan forever with no port bound and no /health. It must now fail promptly
  and loudly, including when only ONE of N workers is broken.
* **Mid-loop death**: a worker that dies used to leave ``ready`` set, so
  /health kept answering 200 while permits drained into a queue nobody served.
  It must now be restarted a BOUNDED number of times, and once the engine gives
  up the replica must report not-ready so the process supervisor replaces it.
"""
from __future__ import annotations

import dataclasses
import logging
import sys
import threading
import time
import types
import unittest

from service.tests import fake_engine  # installs shims — must precede engine use

import service.app as appmod
import service.engine as enginemod
from service.engine import EngineStartupError, TtsEngine, _Worker


class _FakeAudio:
    def detach(self):
        return self

    def to(self, *a, **k):
        return self

    def squeeze(self):
        return self

    def numel(self):
        return 24000


class _Model:
    """Serves voice states and generates instantly, unless told to explode."""

    sample_rate = 24000

    def __init__(self, fatal_texts: "set[str] | None" = None) -> None:
        self.generated: list[str] = []
        self.fatal_texts = fatal_texts if fatal_texts is not None else set()

    def get_state_for_audio_prompt(self, source, truncate=True):
        return {"src": source}

    def generate_audio(self, state, text, max_tokens, frames_after_eos, copy_state):
        self.generated.append(text)
        if text in self.fatal_texts:
            # NOT an Exception: this is the "the worker thread itself dies"
            # shape (MemoryError-class / signal-class), which the per-job
            # handler must resolve-then-re-raise rather than swallow.
            raise KeyboardInterrupt("worker died mid-loop")
        return _FakeAudio()


class _EngineHarness(unittest.TestCase):
    """Patches SETTINGS + the pocket_tts shim for one engine under test."""

    workers = 1

    def _install(self, load_model) -> None:
        self._orig_settings = enginemod.SETTINGS
        self._orig_wav = enginemod.audio_to_wav_bytes
        self._orig_tts = sys.modules["pocket_tts"].TTSModel
        enginemod.SETTINGS = dataclasses.replace(
            self._orig_settings, workers=self.workers, queue_max=8, torch_threads=1)
        enginemod.audio_to_wav_bytes = lambda audio, sr: b"WAV"
        sys.modules["pocket_tts"].TTSModel = types.SimpleNamespace(
            load_model=load_model)
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        enginemod.SETTINGS = self._orig_settings
        enginemod.audio_to_wav_bytes = self._orig_wav
        sys.modules["pocket_tts"].TTSModel = self._orig_tts


class StartupFailureTests(_EngineHarness):
    def test_load_failure_fails_startup_loudly(self) -> None:
        def _boom(language, quantize):
            raise RuntimeError("model weights are corrupt")

        self._install(_boom)
        eng = TtsEngine()
        with self.assertLogs("gravitone.engine", level="ERROR") as logs:
            with self.assertRaises(EngineStartupError) as ctx:
                eng.start()
        # The real cause travels with the error, not just in a thread traceback.
        self.assertIsInstance(ctx.exception.__cause__, RuntimeError)
        self.assertIn("model weights are corrupt", str(ctx.exception))
        self.assertTrue(any("model load failed" in r.getMessage() for r in logs.records))
        self.assertTrue(any(r.levelno >= logging.CRITICAL for r in logs.records))
        # And the replica never claims to be ready.
        self.assertFalse(eng.ready)
        self.assertEqual(eng.live_workers, 0)

    def test_partial_load_failure_is_equally_visible(self) -> None:
        self.workers = 2
        seen = {"n": 0}
        lock = threading.Lock()

        def _one_bad(language, quantize):
            with lock:
                seen["n"] += 1
                nth = seen["n"]
            if nth == 2:
                raise RuntimeError("second instance OOMed")
            return _Model()

        self._install(_one_bad)
        eng = TtsEngine()
        with self.assertRaises(EngineStartupError) as ctx:
            eng.start()
        self.assertIn("1 of 2", str(ctx.exception))
        self.assertFalse(eng.ready)

    def test_hung_load_times_out_instead_of_hanging_forever(self) -> None:
        release = threading.Event()
        self.addCleanup(release.set)

        def _hang(language, quantize):
            release.wait(10)
            return _Model()

        self._install(_hang)
        orig_timeout = enginemod._MODEL_LOAD_TIMEOUT_S
        enginemod._MODEL_LOAD_TIMEOUT_S = 0.2
        self.addCleanup(setattr, enginemod, "_MODEL_LOAD_TIMEOUT_S", orig_timeout)
        eng = TtsEngine()
        t0 = time.monotonic()
        with self.assertRaises(EngineStartupError) as ctx:
            eng.start()
        self.assertLess(time.monotonic() - t0, 5, "start() did not fail promptly")
        self.assertIn("still loading", str(ctx.exception))


class WorkerDeathTests(_EngineHarness):
    def _engine(self, fatal_texts: "set[str]") -> TtsEngine:
        self.models: list[_Model] = []

        def _load(language, quantize):
            m = _Model(fatal_texts=fatal_texts)
            self.models.append(m)
            return m

        self._install(_load)
        eng = TtsEngine()
        eng.start()
        self.addCleanup(lambda: eng.stop(drain_timeout_s=2))
        return eng

    @staticmethod
    def _wait(pred, timeout: float = 5.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if pred():
                return True
            time.sleep(0.01)
        return False

    def test_worker_dying_mid_loop_is_restarted_and_service_recovers(self) -> None:
        eng = self._engine(fatal_texts={"kill"})
        job = eng.submit(voice_id="v", text="kill")
        # The caller is NOT left hanging: the future resolves even though the
        # worker thread is dying (repo law — every future resolves exactly once).
        self.assertTrue(self._wait(lambda: job.future.done()))
        self.assertIsInstance(job.future.exception(), KeyboardInterrupt)
        # The permit came back too (released in the per-job finally).
        self.assertTrue(self._wait(
            lambda: eng.available_permits() == eng._max_inflight))
        # A replacement worker took the slot and the engine serves again.
        self.assertTrue(self._wait(lambda: eng.live_workers == 1))
        self.assertTrue(self._wait(lambda: eng._workers[0].generation == 1))
        ok = eng.submit(voice_id="v", text="fine")
        self.assertTrue(self._wait(lambda: ok.future.done()))
        self.assertEqual(ok.future.result().sample_rate, 24000)
        # in_flight did not inflate after the death.
        self.assertEqual(eng.metrics.snapshot()["in_flight"], 0)

    def test_restarts_are_bounded_and_giving_up_is_visible(self) -> None:
        eng = self._engine(fatal_texts={"kill"})
        with self.assertLogs("gravitone.engine", level="ERROR") as logs:
            for _ in range(enginemod._WORKER_RESTART_MAX + 1):
                job = eng.submit(voice_id="v", text="kill")
                self.assertTrue(self._wait(lambda: job.future.done()))
                # Let the replacement (if any) come up before the next kill.
                self._wait(lambda: eng.live_workers == 1, timeout=2)
            self.assertTrue(self._wait(lambda: eng.failed))
        # Crash loop is not masked: the engine gave up and SAYS so.
        self.assertTrue(any("giving up" in r.getMessage() for r in logs.records))
        self.assertTrue(any(r.levelno >= logging.CRITICAL for r in logs.records))
        self.assertFalse(eng.ready)
        self.assertEqual(eng.live_workers, 0)

    def test_health_is_503_when_no_worker_is_live(self) -> None:
        from fastapi.testclient import TestClient

        eng = self._engine(fatal_texts=set())
        # Simulate the post-give-up state without burning the whole budget.
        eng._workers_failed = True
        orig = appmod.ENGINE
        appmod.ENGINE = eng
        self.addCleanup(setattr, appmod, "ENGINE", orig)
        client = TestClient(appmod.app, raise_server_exceptions=False)
        resp = client.get("/health")
        self.assertEqual(resp.status_code, 503)
        body = resp.json()
        self.assertEqual(body["status"], "unavailable")
        self.assertEqual(body["workers_configured"], 1)

    def test_health_ready_reports_live_worker_count(self) -> None:
        from fastapi.testclient import TestClient

        eng = self._engine(fatal_texts=set())
        orig = appmod.ENGINE
        appmod.ENGINE = eng
        self.addCleanup(setattr, appmod, "ENGINE", orig)
        client = TestClient(appmod.app, raise_server_exceptions=False)
        resp = client.get("/health")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["workers_live"], 1)


class LoopResilienceTests(_EngineHarness):
    """A transient scaffolding error is survived; a persistent one is not."""

    def test_transient_loop_error_is_survived(self) -> None:
        self._install(lambda language, quantize: _Model())
        eng = TtsEngine()
        eng.start()
        self.addCleanup(lambda: eng.stop(drain_timeout_s=2))
        worker = eng._workers[0]
        # Break the dequeue ONCE, then let it heal.
        real_get = eng._queue.get
        state = {"n": 0}

        def _flaky(*a, **k):
            state["n"] += 1
            if state["n"] == 1:
                raise OSError("transient queue failure")
            return real_get(*a, **k)

        eng._queue.get = _flaky  # type: ignore[method-assign]
        # Cleanups are LIFO: registered last, so it un-patches BEFORE stop().
        self.addCleanup(lambda: setattr(eng._queue, "get", real_get))
        with self.assertLogs("gravitone.engine", level="ERROR"):
            deadline = time.time() + 5
            while state["n"] < 2 and time.time() < deadline:
                time.sleep(0.01)
        self.assertGreaterEqual(state["n"], 2, "worker never re-entered the loop")
        job = eng.submit(voice_id="v", text="after")
        deadline = time.time() + 5
        while not job.future.done() and time.time() < deadline:
            time.sleep(0.01)
        self.assertTrue(job.future.done(), "worker did not survive a loop error")
        self.assertTrue(worker.is_alive())

    def test_persistent_loop_error_kills_the_worker(self) -> None:
        self._install(lambda language, quantize: _Model())
        eng = TtsEngine()
        eng.start()
        self.addCleanup(lambda: eng.stop(drain_timeout_s=2))

        real_get = eng._queue.get

        def _always_broken(*a, **k):
            raise OSError("queue is gone")

        eng._queue.get = _always_broken  # type: ignore[method-assign]
        # Cleanups are LIFO: registered last, so it un-patches BEFORE stop().
        self.addCleanup(lambda: setattr(eng._queue, "get", real_get))
        deadline = time.time() + 5
        # The original worker gives up after _LOOP_ERRORS_MAX consecutive
        # failures; the engine then restarts the slot (bounded), so what we
        # assert is that the death was NOTICED at all.
        while eng._workers[0].generation == 0 and time.time() < deadline:
            time.sleep(0.01)
        self.assertGreater(eng._workers[0].generation, 0,
                           "a wedged loop never surfaced as a worker death")


class WorkerStartupContractTests(unittest.TestCase):
    def test_startup_done_is_independent_of_ready(self) -> None:
        # The distinction is the whole fix: `ready` means "serving", while
        # `startup_done` means "the load attempt finished, either way".
        w = _Worker(0, None)
        self.assertFalse(w.startup_done.is_set())
        self.assertFalse(w.ready.is_set())
        self.assertIsNone(w.load_error)


if __name__ == "__main__":
    unittest.main()
