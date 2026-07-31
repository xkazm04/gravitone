"""Nobody is charged admission for a request nobody is waiting for.

Proves, against the REAL ``TtsEngine`` and at the HTTP level:

* abandoning a QUEUED job frees its admission permit immediately (not whenever
  a worker finally dequeues it), so a disconnected client stops costing
  capacity at once;
* the claim protocol makes double-release / double-run structurally impossible
  when a worker later reaches an already-abandoned job;
* the counters cannot go negative or leak — including when a worker dies
  mid-job, which used to inflate ``in_flight`` permanently;
* cache hits and single-flight collapses are counted, so ``received`` is again
  the number of requests this replica served.
"""
from __future__ import annotations

import dataclasses
import sys
import threading
import time
import types
import unittest

from service.tests import fake_engine  # installs shims — must precede engine use

import service.app as appmod
import service.engine as enginemod
from service.engine import Metrics, ShuttingDown, TtsEngine


class _FakeAudio:
    def detach(self):
        return self

    def to(self, *a, **k):
        return self

    def squeeze(self):
        return self

    def numel(self):
        return 24000


class _GatedModel:
    sample_rate = 24000

    def __init__(self) -> None:
        self.generated: list[str] = []
        self.gate = threading.Event()
        self.entered = threading.Event()

    def get_state_for_audio_prompt(self, source, truncate=True):
        return {"src": source}

    def generate_audio(self, state, text, max_tokens, frames_after_eos, copy_state):
        self.generated.append(text)
        self.entered.set()
        self.gate.wait(5)
        return _FakeAudio()


class MetricsGuardTests(unittest.TestCase):
    """Gauges are floored and owned by one place each."""

    def test_queued_cannot_go_negative(self) -> None:
        m = Metrics()
        m.on_abandoned()
        m.on_drain()
        with m.job_running():
            pass
        self.assertEqual(m.snapshot()["queued"], 0)

    def test_in_flight_is_released_even_on_baseexception(self) -> None:
        m = Metrics()
        m.on_enqueue()
        with self.assertRaises(KeyboardInterrupt):
            with m.job_running():
                raise KeyboardInterrupt("worker dying mid-job")
        # The gauge came back down: a dead worker does not inflate it forever.
        self.assertEqual(m.snapshot()["in_flight"], 0)
        self.assertEqual(m.snapshot()["queued"], 0)

    def test_in_flight_cannot_go_negative(self) -> None:
        m = Metrics()
        m.on_error()          # no matching job_running()
        m.on_finish(1.0, 1.0, 1.0)
        self.assertEqual(m.snapshot()["in_flight"], 0)

    def test_cache_hits_and_collapses_count_as_requests(self) -> None:
        m = Metrics()
        m.on_received()
        m.on_cache_hit()
        m.on_cache_hit()
        m.on_collapsed()
        snap = m.snapshot()
        # `received` is once again "requests served by this replica".
        self.assertEqual(snap["received"], 4)
        self.assertEqual(snap["cache_hits"], 2)
        self.assertEqual(snap["collapsed"], 1)
        # They are NOT synthesis: no permit, no worker, no completion.
        self.assertEqual(snap["completed"], 0)
        self.assertEqual(snap["in_flight"], 0)


class AbandonReleasesCapacityTests(unittest.TestCase):
    """Engine-level: the permit comes back the moment the caller gives up."""

    def setUp(self) -> None:
        self._orig_settings = enginemod.SETTINGS
        self._orig_wav = enginemod.audio_to_wav_bytes
        self._orig_tts = sys.modules["pocket_tts"].TTSModel
        enginemod.SETTINGS = dataclasses.replace(
            self._orig_settings, workers=1, queue_max=3, torch_threads=1)
        enginemod.audio_to_wav_bytes = lambda audio, sr: b"WAV"
        self.model = _GatedModel()
        sys.modules["pocket_tts"].TTSModel = types.SimpleNamespace(
            load_model=lambda language, quantize: self.model)
        self.eng = TtsEngine()
        self.eng.start()

    def tearDown(self) -> None:
        self.model.gate.set()
        try:
            self.eng.stop(drain_timeout_s=2)
        except Exception:  # noqa: BLE001
            pass
        enginemod.SETTINGS = self._orig_settings
        enginemod.audio_to_wav_bytes = self._orig_wav
        sys.modules["pocket_tts"].TTSModel = self._orig_tts

    def _wait(self, pred, timeout: float = 5.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if pred():
                return True
            time.sleep(0.01)
        return False

    def test_admission_returns_before_the_queue_is_ever_drained(self) -> None:
        # Fill the engine: 1 in-flight (gated) + queue_max queued = full.
        running = self.eng.submit(voice_id="v", text="running")
        self.assertTrue(self.model.entered.wait(5))
        queued = [self.eng.submit(voice_id="v", text=f"q{i}")
                  for i in range(enginemod.SETTINGS.queue_max)]
        self.assertEqual(self.eng.available_permits(), 0)
        with self.assertRaises(enginemod.AdmissionRejected):
            self.eng.submit(voice_id="v", text="rejected")

        # Two callers give up. Capacity must return NOW — the single worker is
        # still stuck inside the gated generation and will not dequeue anything.
        queued[0].abandoned.set()
        queued[1].abandoned.set()
        self.assertEqual(self.eng.available_permits(), 2)
        self.assertEqual(self.eng.metrics.abandoned, 2)

        # ...and that capacity is really usable: a new caller is admitted
        # instead of getting a 429 while the service holds slots for the gone.
        fresh = self.eng.submit(voice_id="v", text="fresh")
        self.assertFalse(fresh.future.done())

        # Now let the worker run: it must skip BOTH abandoned jobs without
        # running them and without releasing their permits a second time.
        self.model.gate.set()
        self.assertTrue(self._wait(lambda: fresh.future.done()))
        self.assertTrue(running.future.done())
        for j in queued[:2]:
            self.assertTrue(j.future.cancelled())
        self.assertNotIn("q0", self.model.generated)
        self.assertNotIn("q1", self.model.generated)
        # Every permit accounted for exactly once — never over-released.
        self.assertTrue(self._wait(
            lambda: self.eng.available_permits() == self.eng._max_inflight))
        self.assertEqual(self.eng.available_permits(), self.eng._max_inflight)
        snap = self.eng.metrics.snapshot()
        self.assertEqual(snap["queued"], 0)
        self.assertEqual(snap["in_flight"], 0)
        self.assertEqual(snap["abandoned"], 2)

    def test_double_abandon_releases_exactly_one_permit(self) -> None:
        self.model.gate.set()  # nothing blocks
        job = self.eng.submit(voice_id="v", text="x")
        before = self.eng.available_permits()
        job.abandoned.set()
        job.abandoned.set()
        job.abandoned.set()
        self.assertLessEqual(self.eng.available_permits(), self.eng._max_inflight)
        self.assertGreaterEqual(self.eng.available_permits(), before)
        self.assertEqual(self.eng.metrics.abandoned, 1)
        self.assertTrue(self._wait(
            lambda: self.eng.available_permits() == self.eng._max_inflight))
        self.assertEqual(self.eng.available_permits(), self.eng._max_inflight)

    def test_abandoning_a_running_job_does_not_release_a_live_permit(self) -> None:
        # The worker claimed this job and is inside generate_audio: its permit
        # is genuinely in use, so the abandon hook must NOT hand it back (that
        # would over-admit the pool).
        job = self.eng.submit(voice_id="v", text="running")
        self.assertTrue(self.model.entered.wait(5))
        held = self.eng.available_permits()
        job.abandoned.set()
        self.assertEqual(self.eng.available_permits(), held)
        self.assertEqual(self.eng.metrics.abandoned, 0)
        self.model.gate.set()
        self.assertTrue(self._wait(lambda: job.future.done()))
        self.assertEqual(self.eng.available_permits(), self.eng._max_inflight)

    def test_drain_skips_an_already_abandoned_job(self) -> None:
        self.eng.submit(voice_id="v", text="running")
        self.assertTrue(self.model.entered.wait(5))
        job = self.eng.submit(voice_id="v", text="q")
        job.abandoned.set()
        self.model.gate.set()
        self.eng.stop(drain_timeout_s=3)
        # Still cancelled (not re-resolved as ShuttingDown) and the permit was
        # released exactly once by the abandon hook.
        self.assertTrue(job.future.cancelled())
        self.assertEqual(self.eng.available_permits(), self.eng._max_inflight)
        self.assertEqual(self.eng.metrics.snapshot()["queued"], 0)


class AbandonFreesCapacityOverHttpTests(unittest.TestCase):
    """The whole point, at the HTTP level: a 504'd caller stops costing a slot.

    Only provable now that ``FakeEngine`` honours ``job.abandoned`` — it used to
    ignore the flag entirely, so abandoned jobs still ran and still held their
    slot no matter what the real engine did.
    """

    def setUp(self) -> None:
        from fastapi.testclient import TestClient
        self._orig_engine = appmod.ENGINE
        self._orig_settings = appmod.SETTINGS
        appmod.SYNTH_CACHE.clear()  # process-wide singleton — isolate cases
        appmod.SETTINGS = dataclasses.replace(self._orig_settings,
                                              request_timeout_s=0.2)
        # One worker, two admission slots: enough for the pinned job plus one.
        self.eng = fake_engine.FakeEngine(
            workers=1, capacity=2, delay=0.02,
            delays={"pinned": 3.0, "abandon me": 0.02, "later": 0.02})
        appmod.ENGINE = self.eng
        self.client = TestClient(appmod.app, raise_server_exceptions=False)

    def tearDown(self) -> None:
        self.eng.close()
        appmod.ENGINE = self._orig_engine
        appmod.SETTINGS = self._orig_settings
        appmod.SYNTH_CACHE.clear()

    def _post(self, text: str):
        return self.client.post("/v1/text-to-speech/alba",
                                params={"output_format": "wav_24000"},
                                json={"text": text})

    def test_timed_out_request_returns_its_slot_immediately(self) -> None:
        # Pin the single worker with a long job on a side thread.
        pinned: list = []
        t = threading.Thread(target=lambda: pinned.append(self._post("pinned")),
                             daemon=True)
        t.start()
        deadline = time.time() + 5
        while not self.eng.executed and time.time() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.eng.executed, ["pinned"], "worker never got pinned")

        # This one can only queue behind it, so it 504s — and the caller is gone.
        resp = self._post("abandon me")
        self.assertEqual(resp.status_code, 504)

        # Capacity came back at that moment: only the still-running job holds a
        # slot, so a fresh request is ADMITTED rather than 429'd.
        self.assertTrue(self.eng.jobs[1].future.cancelled())
        deadline = time.time() + 2
        while self.eng._admitted > 1 and time.time() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.eng._admitted, 1,
                         "the abandoned request kept holding its admission slot")
        follow_up = self._post("later")
        self.assertNotEqual(follow_up.status_code, 429)

        # And the abandoned request never ran: no generation was burned on a
        # result nobody would read.
        self.assertNotIn("abandon me", self.eng.executed)
        t.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
