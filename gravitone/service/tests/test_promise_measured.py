"""Promises are MEASURED: the engine grades its own homework.

``X-Gravitone-Deadline`` was stamped and never checked. The engine promised a
latency, the header went out, and nothing on the box ever compared that number
to what actually happened — so "we keep our promises" was an assertion about
code, not a measurement. Four things are proven here, all through the real
submission path against the real ``TtsEngine`` (fake, gated pocket-tts models):

* a KEPT promise and a BROKEN one both land in ``snapshot()["promises"]`` with
  a hit rate and a SIGNED error (negative = came back early), i.e. the writer
  is production code and the values move;
* an unmeetable deadline is NOT degraded — full quality plus a recorded miss,
  because the cheapest audio AND a missed deadline is the one outcome nobody
  wanted;
* the ladder fractions (0.7/0.5) are calibrated from observation when the
  engine has seen the level, and a promise resting on the UNCALIBRATED constant
  is withheld rather than stamped with borrowed authority;
* ``_pending_est_s`` — the numerator of every predicted wait and every promise
  — is reconciled against the queue itself, so a forced drift is corrected.
"""
from __future__ import annotations

import dataclasses
import sys
import threading
import time
import types
import unittest

from service.tests import fake_engine  # installs shims — must precede engine use

import service.engine as enginemod  # noqa: E402
from service.engine import Job, Metrics, TtsEngine, QUALITY_FULL  # noqa: E402


class _FakeAudio:
    def detach(self):
        return self

    def to(self, *a, **k):
        return self

    def squeeze(self):
        return self

    def numel(self):
        return 24000


class _SlowModel:
    """A model whose render takes ``render_s`` — long enough to break a
    promise made from a window of fast renders."""

    sample_rate = 24000

    def __init__(self, render_s: float = 0.0) -> None:
        self.render_s = render_s
        self.generated: list[str] = []
        self.entered = threading.Event()

    def get_state_for_audio_prompt(self, source, truncate=True):
        return {"src": source}

    def generate_audio(self, state, text, max_tokens, frames_after_eos,
                       copy_state):
        self.generated.append(text)
        self.entered.set()
        time.sleep(self.render_s)
        return _FakeAudio()


class _EngineCase(unittest.TestCase):
    render_s = 0.0

    def setUp(self) -> None:
        self._orig_settings = enginemod.SETTINGS
        self._orig_wav = enginemod.audio_to_wav_bytes
        self._orig_tts = sys.modules["pocket_tts"].TTSModel
        enginemod.SETTINGS = dataclasses.replace(
            self._orig_settings, workers=1, queue_max=8, torch_threads=1)
        enginemod.audio_to_wav_bytes = lambda audio, sr: b"WAV"
        self.model = _SlowModel(self.render_s)
        sys.modules["pocket_tts"].TTSModel = types.SimpleNamespace(
            load_model=lambda language, quantize: self.model)
        self.eng = TtsEngine()
        self.eng.start()

    def tearDown(self) -> None:
        try:
            self.eng.stop(drain_timeout_s=2)
        except Exception:  # noqa: BLE001
            pass
        enginemod.SETTINGS = self._orig_settings
        enginemod.audio_to_wav_bytes = self._orig_wav
        sys.modules["pocket_tts"].TTSModel = self._orig_tts

    def _warm(self, proc_s: float = 1.0, audio_s: float = 1.0) -> None:
        for _ in range(enginemod._WARM_WINDOW):
            self.eng.metrics.on_finish(latency_s=proc_s, proc_s=proc_s,
                                       audio_s=audio_s)

    def _wait(self, pred, timeout: float = 5.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if pred():
                return True
            time.sleep(0.01)
        return False


# ---------------------------------------------------------------------------
# 1. Promise vs actual, through the real path
# ---------------------------------------------------------------------------
class KeptPromiseTests(_EngineCase):
    render_s = 0.0

    def test_a_kept_promise_is_counted_and_its_error_is_signed(self) -> None:
        # A warm window of one-second renders promises seconds; the fake model
        # returns instantly, so the promise is kept by a wide margin.
        self._warm(proc_s=1.0, audio_s=1.0)
        job = self.eng.submit(voice_id="v", text="x" * 300)
        self.assertIsNotNone(job.promised_s, "a warm window must promise")
        self.assertTrue(self._wait(lambda: job.future.done()))
        self.assertTrue(self._wait(
            lambda: self.eng.metrics.promises()["promised"] == 1))
        p = self.eng.metrics.promises()
        self.assertEqual((p["kept"], p["missed"]), (1, 0))
        self.assertEqual(p["hit_rate"], 1.0)
        # Signed: it came back EARLY, so the error is negative.
        self.assertLess(p["error_p50_s"], 0.0)
        self.assertLess(p["error_mean_s"], 0.0)

    def test_the_promise_surface_is_on_the_snapshot(self) -> None:
        snap = self.eng.metrics.snapshot()
        self.assertIn("promises", snap)
        # Nested, like cost_model: replicas.AGG_KEYS classifies every top-level
        # scalar, and a hit RATE is neither summable nor averageable.
        self.assertIsInstance(snap["promises"], dict)
        self.assertIsNone(snap["promises"]["hit_rate"],
                          "a rate over zero samples is no score, not a perfect one")

    def test_a_job_that_was_never_promised_is_not_counted_as_a_hit(self) -> None:
        # Cold window: no promise. It must not inflate the hit rate.
        job = self.eng.submit(voice_id="v", text="hello")
        self.assertIsNone(job.promised_s)
        self.assertTrue(self._wait(lambda: job.future.done()))
        self.assertEqual(self.eng.metrics.promises()["promised"], 0)


class BrokenPromiseTests(_EngineCase):
    render_s = 0.35

    def test_a_broken_promise_is_counted_with_a_positive_error(self) -> None:
        # A warm window of MILLISECOND renders mints a promise of ~nothing;
        # the model then takes 0.35s. The engine must say so.
        self._warm(proc_s=0.001, audio_s=1.0)
        job = self.eng.submit(voice_id="v", text="x" * 10)
        self.assertIsNotNone(job.promised_s)
        self.assertLess(job.promised_s, 0.1)
        self.assertTrue(self._wait(lambda: job.future.done()))
        self.assertTrue(self._wait(
            lambda: self.eng.metrics.promises()["promised"] == 1))
        p = self.eng.metrics.promises()
        self.assertEqual((p["kept"], p["missed"]), (0, 1))
        self.assertEqual(p["hit_rate"], 0.0)
        self.assertGreater(p["error_p50_s"], 0.0)   # late, and it admits it

    def test_a_missed_caller_deadline_is_counted_separately(self) -> None:
        self._warm(proc_s=0.001, audio_s=1.0)
        job = self.eng.submit(voice_id="v", text="x" * 10, deadline_s=0.05)
        self.assertTrue(self._wait(lambda: job.future.done()))
        self.assertTrue(self._wait(
            lambda: self.eng.metrics.promises()["deadlines"]["seen"] == 1))
        d = self.eng.metrics.promises()["deadlines"]
        self.assertEqual((d["met"], d["missed"]), (0, 1))
        self.assertEqual(d["hit_rate"], 0.0)


# ---------------------------------------------------------------------------
# 2. No rung fits -> full quality (and the miss is recorded)
# ---------------------------------------------------------------------------
class NoRungFitsTests(unittest.TestCase):
    """Straight at ``_degrade``: the decision, without a live pool."""

    @staticmethod
    def _job(deadline_s: float, est: float = 10.0, **kw) -> Job:
        return Job(voice_id="v", text="t", max_tokens=100,
                   frames_after_eos=None, deadline_s=deadline_s,
                   degrade_allowed=True, est_synth_s=est, **kw)

    def test_no_rung_fits_leaves_the_job_alone(self) -> None:
        job = self._job(deadline_s=0.1)
        self.assertFalse(TtsEngine._degrade(job, predicted_wait_s=0.0))
        self.assertEqual(job.quality_level, QUALITY_FULL)
        self.assertEqual(job.overrides, {})
        self.assertIsNone(job.frames_after_eos)
        self.assertEqual(job.est_synth_s, 10.0)
        self.assertIsNone(job.degrade_basis)

    def test_the_bottom_rung_is_taken_when_only_it_fits(self) -> None:
        # 0.5 fits, 0.7 does not: the ladder is walked, not skipped.
        job = self._job(deadline_s=6.0)
        self.assertTrue(TtsEngine._degrade(job, predicted_wait_s=0.0))
        self.assertEqual(job.quality_level, "minimal")
        self.assertEqual(job.overrides["lsd_decode_steps"], 1)

    def test_a_measured_fraction_replaces_the_assumed_one(self) -> None:
        # This box measured "reduced" at 0.4 of full, not the assumed 0.7 — so
        # a deadline the constant would have declared unfittable IS fittable.
        job = self._job(deadline_s=4.5)
        self.assertFalse(TtsEngine._degrade(job, predicted_wait_s=0.0))
        job = self._job(deadline_s=4.5)
        self.assertTrue(TtsEngine._degrade(
            job, predicted_wait_s=0.0,
            fractions={"reduced": (0.4, "measured")}))
        self.assertEqual(job.quality_level, "reduced")
        self.assertEqual(job.est_synth_s, 4.0)
        self.assertEqual(job.degrade_basis, "measured")


# ---------------------------------------------------------------------------
# 3. Measured basis vs guessed basis
# ---------------------------------------------------------------------------
class LadderCalibrationTests(unittest.TestCase):

    @staticmethod
    def _fill(m: Metrics, n: int, level: str, proc_s: float, audio_s: float):
        for _ in range(n):
            m.on_finish(latency_s=proc_s, proc_s=proc_s, audio_s=audio_s,
                        quality_level=level)

    def test_an_unseen_level_is_assumed_not_measured(self) -> None:
        m = Metrics()
        self._fill(m, enginemod._WARM_WINDOW, QUALITY_FULL, 1.0, 1.0)
        fractions = m.ladder_fractions()
        self.assertEqual(fractions["reduced"], (None, "assumed"))
        # The reported fraction falls back to the ladder's constant, LABELLED.
        ladder = m.promises()["ladder"]["reduced"]
        self.assertEqual(ladder["basis"], "assumed")
        self.assertEqual(ladder["fraction"], 0.7)

    def test_a_seen_level_is_measured_from_the_windows(self) -> None:
        m = Metrics()
        self._fill(m, enginemod._WARM_WINDOW, QUALITY_FULL, 1.0, 1.0)
        # "reduced" produced the same audio in 0.4s: a measured fraction of 0.4,
        # nothing like the assumed 0.7.
        self._fill(m, enginemod._LADDER_WARM_WINDOW, "reduced", 0.4, 1.0)
        fraction, basis = m.ladder_fractions()["reduced"]
        self.assertEqual(basis, "measured")
        self.assertAlmostEqual(fraction, 0.4, places=2)
        self.assertEqual(m.promises()["ladder"]["reduced"]["samples"],
                         enginemod._LADDER_WARM_WINDOW)

    def test_a_level_that_measured_slower_is_clamped_to_one(self) -> None:
        # A "cheaper" rung that measured SLOWER is not a saving; letting a
        # noisy window claim 3.0 would be worse than the constant.
        m = Metrics()
        self._fill(m, enginemod._WARM_WINDOW, QUALITY_FULL, 1.0, 1.0)
        self._fill(m, enginemod._LADDER_WARM_WINDOW, "minimal", 3.0, 1.0)
        fraction, basis = m.ladder_fractions()["minimal"]
        self.assertEqual(basis, "measured")
        self.assertEqual(fraction, 1.0)


class PromiseBasisTests(_EngineCase):
    """A promise built on an uncalibrated fraction is WITHHELD."""

    def _fill_level(self, level: str, proc_s: float) -> None:
        for _ in range(enginemod._LADDER_WARM_WINDOW):
            self.eng.metrics.on_finish(latency_s=proc_s, proc_s=proc_s,
                                       audio_s=1.0, quality_level=level)

    def _degrading_submit(self):
        """Submit a job whose deadline only a degraded render can meet."""
        text = "b" * 4000
        full = self.eng.metrics.cost_estimate(
            len(text), enginemod.SETTINGS.max_tokens)["est_synth_s"]
        deadline = self.eng.predicted_wait_s() + full * 0.8
        return self.eng.submit(voice_id="v", text=text, deadline_s=deadline,
                               degrade_allowed=True)

    def test_a_degraded_job_on_an_assumed_fraction_gets_no_promise(self) -> None:
        self._warm(proc_s=1.0, audio_s=1.0)
        job = self._degrading_submit()
        self.assertEqual(job.quality_level, "reduced")
        self.assertEqual(job.degrade_basis, "assumed")
        self.assertIsNone(job.promised_s,
                          "a promise resting on an invented 0.7 is a guess "
                          "wearing a measured header")

    def test_the_same_job_IS_promised_once_the_level_is_measured(self) -> None:
        self._warm(proc_s=1.0, audio_s=1.0)
        self._fill_level("reduced", 0.7)
        job = self._degrading_submit()
        self.assertEqual(job.degrade_basis, "measured")
        self.assertIsNotNone(job.promised_s)

    def test_a_full_quality_job_is_still_promised_from_a_warm_window(self) -> None:
        # The no-change pin: nothing about the basis rule touches the ordinary
        # (undegraded) promise.
        self._warm(proc_s=1.0, audio_s=1.0)
        job = self.eng.submit(voice_id="v", text="hello there")
        self.assertIsNone(job.degrade_basis)
        self.assertIsNotNone(job.promised_s)


# ---------------------------------------------------------------------------
# 4. The pending estimate is reconciled against the real queue
# ---------------------------------------------------------------------------
class PendingReconciliationTests(_EngineCase):
    render_s = 0.4

    def test_a_forced_upward_drift_is_corrected(self) -> None:
        self._warm()
        running = self.eng.submit(voice_id="v", text="a" * 300)
        self.assertTrue(self.model.entered.wait(5))
        queued = self.eng.submit(voice_id="v", text="b" * 300)
        truth = self.eng._queue.pending_est_s()
        self.assertGreater(truth, 0.0)
        # Poison the running total the way a lost settle would.
        with self.eng._pending_lock:
            self.eng._pending_est_s += 99.0
        self.assertAlmostEqual(self.eng._reconcile_pending(force=True), truth, 3)
        self.assertAlmostEqual(self.eng._pending_drift_s, -99.0, 3)
        self.assertTrue(self._wait(lambda: queued.future.done(), 10))
        self.assertTrue(running.future.done())

    def test_a_forced_downward_drift_is_corrected(self) -> None:
        self._warm()
        self.eng.submit(voice_id="v", text="a" * 300)
        self.assertTrue(self.model.entered.wait(5))
        self.eng.submit(voice_id="v", text="b" * 300)
        truth = self.eng._queue.pending_est_s()
        with self.eng._pending_lock:
            self.eng._pending_est_s = 0.0     # a phantom-empty queue
        self.assertAlmostEqual(self.eng._reconcile_pending(force=True), truth, 3)
        self.assertGreater(self.eng._pending_drift_s, 0.0)

    def test_reconciliation_is_rate_limited_not_a_sweeper(self) -> None:
        # Cheap because it is bounded AND because it does not run on every
        # call: two reconciles inside the interval do one walk.
        self._warm()
        self.eng._reconcile_pending(force=True)
        with self.eng._pending_lock:
            self.eng._pending_est_s = 42.0
        self.assertEqual(self.eng._reconcile_pending(), 42.0)
        self.assertEqual(self.eng._reconcile_pending(force=True), 0.0)

    def test_a_claimed_job_is_not_counted_by_the_truth(self) -> None:
        # A claimed job has already settled its cost; its queue entry is a
        # tombstone. Counting it would re-add cost the settle just removed.
        self._warm()
        self.eng.submit(voice_id="v", text="a" * 300)
        self.assertTrue(self.model.entered.wait(5))
        queued = self.eng.submit(voice_id="v", text="b" * 300)
        queued.abandoned.set()                 # claims it, settles its cost
        self.assertEqual(self.eng._queue.pending_est_s(), 0.0)
        self.assertEqual(self.eng._reconcile_pending(force=True), 0.0)


if __name__ == "__main__":
    unittest.main()
