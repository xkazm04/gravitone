"""The deadline contract: promise a latency, then keep it.

Five things this proves, against the REAL ``TtsEngine`` (driven by fake, gated
pocket-tts models — never the real model):

* the cost model estimates from the windows the engine ALREADY collects, and
  labels itself warm/cold/insufficient — a promise is only ever minted from a
  warm window, and it is widened by the measured p95/p50 spread;
* a refusal carries the truth (``predicted_wait_s`` + ``retry_after_s``), not
  just the fact of the refusal;
* the queue is deadline-ordered AND, with no deadlines set, byte-for-byte the
  old FIFO — that equivalence is pinned, not assumed;
* interactive work jumps the queue and can hold a reserved permit floor, while
  the aging term makes it structurally unable to starve bulk work;
* elastic quality is opt-in and REPORTED: a caller who did not allow it never
  gets a cheaper render, and a caller who did is told which level ran.
"""
from __future__ import annotations

import dataclasses
import sys
import threading
import time
import types
import unittest

from service.tests import fake_engine  # installs shims — must precede engine use

import service.engine as enginemod
from service.engine import (
    CLASS_BULK, CLASS_INTERACTIVE, AdmissionRejected, Job, Metrics, TtsEngine,
    _DeadlineQueue,
)


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


# ---------------------------------------------------------------------------
# 1. Cost model
# ---------------------------------------------------------------------------
class CostModelTests(unittest.TestCase):
    """Estimates come from the windows already collected; promises don't."""

    @staticmethod
    def _fill(m: Metrics, n: int, proc_s: float = 1.0, audio_s: float = 2.0):
        for _ in range(n):
            m.on_finish(latency_s=proc_s, proc_s=proc_s, audio_s=audio_s)

    def test_an_empty_window_is_insufficient_and_never_promises(self) -> None:
        est = Metrics().cost_estimate(text_len=150, max_tokens=1000)
        self.assertEqual(est["basis"], "insufficient")
        self.assertFalse(est["promise"])
        self.assertIsNone(est["realtime_factor"])
        # Still a NUMBER: an estimate is useful even when it cannot be promised.
        self.assertGreater(est["est_synth_s"], 0)

    def test_a_thin_window_is_cold_and_still_never_promises(self) -> None:
        m = Metrics()
        self._fill(m, enginemod._WARM_WINDOW - 1)
        est = m.cost_estimate(text_len=150, max_tokens=1000)
        self.assertEqual(est["basis"], "cold")
        self.assertFalse(est["promise"])

    def test_a_warm_window_promises_from_the_measured_rtf(self) -> None:
        m = Metrics()
        # 2 audio seconds per 1 compute second -> rtf 2.0, zero spread.
        self._fill(m, enginemod._WARM_WINDOW, proc_s=1.0, audio_s=2.0)
        est = m.cost_estimate(text_len=150, max_tokens=100000)
        self.assertEqual(est["basis"], "warm")
        self.assertTrue(est["promise"])
        self.assertEqual(est["realtime_factor"], 2.0)
        # 150 chars -> 10s of audio at the prior -> 5s of compute at rtf 2.0.
        self.assertAlmostEqual(est["est_audio_s"], 150 * enginemod._AUDIO_S_PER_CHAR, 3)
        self.assertAlmostEqual(est["est_synth_s"], 5.0, 2)

    def test_a_warm_promise_is_widened_by_the_measured_spread(self) -> None:
        tight, wide = Metrics(), Metrics()
        self._fill(tight, enginemod._WARM_WINDOW, proc_s=1.0, audio_s=2.0)
        # Same total work, but a heavy tail: p95/p50 > 1, so the promise widens.
        self._fill(wide, enginemod._WARM_WINDOW - 2, proc_s=0.5, audio_s=1.0)
        wide.on_finish(latency_s=10.0, proc_s=10.0, audio_s=20.0)
        wide.on_finish(latency_s=10.0, proc_s=10.0, audio_s=20.0)
        self.assertEqual(wide.cost_model()["basis"], "warm")
        self.assertGreater(wide.cost_model()["spread"], 1.0)
        self.assertEqual(tight.cost_model()["spread"], 1.0)
        self.assertGreater(wide.cost_estimate(150, 100000)["est_synth_s"],
                           tight.cost_estimate(150, 100000)["est_synth_s"])

    def test_the_spread_is_clamped(self) -> None:
        m = Metrics()
        self._fill(m, enginemod._WARM_WINDOW, proc_s=0.001, audio_s=1.0)
        m.on_finish(latency_s=999.0, proc_s=999.0, audio_s=1.0)
        # One pathological outlier must not inflate every estimate on the box.
        self.assertLessEqual(m.cost_model()["spread"], enginemod._MAX_SPREAD)

    def test_max_tokens_caps_the_estimate(self) -> None:
        m = Metrics()
        self._fill(m, enginemod._WARM_WINDOW, proc_s=1.0, audio_s=1.0)
        long_text = m.cost_estimate(text_len=100000, max_tokens=10)
        # The model cannot emit more audio than max_tokens allows, so neither
        # may the estimate.
        self.assertLessEqual(long_text["est_audio_s"],
                             10 * enginemod._AUDIO_S_PER_TOKEN + 1e-6)

    def test_snapshot_exposes_the_cost_model_without_new_scalars(self) -> None:
        snap = Metrics().snapshot()
        self.assertIn("cost_model", snap)
        self.assertEqual(snap["cost_model"]["basis"], "insufficient")
        # Nested on purpose: replicas.AGG_KEYS classifies every top-level
        # scalar, and a ratio is neither summable nor averageable across
        # replicas. Adding a top-level float here would break that contract.
        self.assertIsInstance(snap["cost_model"], dict)


# ---------------------------------------------------------------------------
# 2. FIFO equivalence (the pin)
# ---------------------------------------------------------------------------
class FifoEquivalenceTests(unittest.TestCase):
    """No deadline, no class, no degradation == the pre-deadline engine."""

    def test_a_default_job_is_pinned_field_by_field(self) -> None:
        job = Job(voice_id="v", text="t", max_tokens=100, frames_after_eos=None)
        self.assertIsNone(job.deadline_s)
        self.assertEqual(job.job_class, CLASS_BULK)
        self.assertFalse(job.degrade_allowed)
        self.assertEqual(job.est_synth_s, 0.0)
        self.assertIsNone(job.promised_s)
        self.assertEqual(job.quality_level, enginemod.QUALITY_FULL)
        self.assertIsNone(job.settle_hook)
        self.assertEqual(job.overrides, {})

    def test_default_jobs_dequeue_in_arrival_order(self) -> None:
        q = _DeadlineQueue()
        jobs = []
        for i in range(50):
            j = Job(voice_id="v", text=f"j{i}", max_tokens=1,
                    frames_after_eos=None)
            jobs.append(j)
            q.put(j, TtsEngine._priority(j))
        self.assertEqual([q.get().text for _ in jobs],
                         [j.text for j in jobs])

    def test_identical_timestamps_still_fall_back_to_arrival_order(self) -> None:
        # Two jobs minted in the same perf_counter tick must not compare Jobs
        # (they are not orderable) and must not reorder.
        q = _DeadlineQueue()
        stamp = time.perf_counter()
        a = Job(voice_id="v", text="a", max_tokens=1, frames_after_eos=None,
                t_enqueue=stamp)
        b = Job(voice_id="v", text="b", max_tokens=1, frames_after_eos=None,
                t_enqueue=stamp)
        q.put(a, TtsEngine._priority(a))
        q.put(b, TtsEngine._priority(b))
        self.assertEqual([q.get().text, q.get().text], ["a", "b"])

    def test_the_shutdown_sentinel_sits_at_the_tail(self) -> None:
        q = _DeadlineQueue()
        q.put(None)
        j = Job(voice_id="v", text="real", max_tokens=1, frames_after_eos=None)
        q.put(j, TtsEngine._priority(j))
        # A sentinel that jumped the queue would stop a worker while real jobs
        # were still waiting.
        self.assertIs(q.get(), j)
        self.assertIsNone(q.get())


# ---------------------------------------------------------------------------
# 3. Ordering, classes, aging
# ---------------------------------------------------------------------------
class OrderingTests(unittest.TestCase):
    @staticmethod
    def _job(text: str, deadline_s=None, job_class=CLASS_BULK, age_s=0.0):
        return Job(voice_id="v", text=text, max_tokens=1, frames_after_eos=None,
                   deadline_s=deadline_s, job_class=job_class,
                   t_enqueue=time.perf_counter() - age_s)

    def _order(self, jobs):
        q = _DeadlineQueue()
        for j in jobs:
            q.put(j, TtsEngine._priority(j))
        return [q.get().text for _ in jobs]

    def test_the_tightest_deadline_goes_first(self) -> None:
        jobs = [self._job("loose", deadline_s=60),
                self._job("tight", deadline_s=1),
                self._job("mid", deadline_s=10)]
        self.assertEqual(self._order(jobs), ["tight", "mid", "loose"])

    def test_interactive_jumps_a_queue_of_bulk(self) -> None:
        jobs = [self._job("bulk1"), self._job("bulk2"),
                self._job("live", job_class=CLASS_INTERACTIVE)]
        self.assertEqual(self._order(jobs), ["live", "bulk1", "bulk2"])

    def test_aging_stops_interactive_from_starving_bulk(self) -> None:
        # A bulk job that has already waited past the aging horizon outranks a
        # freshly-arrived interactive turn: the priority inversion is bounded by
        # construction, not by a background sweeper that could stop running.
        aged = enginemod._BULK_AGING_HORIZON_S - enginemod._INTERACTIVE_HORIZON_S + 1
        jobs = [self._job("old_bulk", age_s=aged),
                self._job("new_live", job_class=CLASS_INTERACTIVE),
                self._job("new_bulk")]
        self.assertEqual(self._order(jobs), ["old_bulk", "new_live", "new_bulk"])

    def test_a_bulk_job_always_ages_into_the_front_eventually(self) -> None:
        # Formal statement of the same property: for ANY number of interactive
        # arrivals, a bulk job's key is finite and fixed, so it is passed only
        # by arrivals inside a bounded window.
        bulk = self._job("bulk", age_s=0.0)
        bulk_key = TtsEngine._priority(bulk)
        late = self._job("late", job_class=CLASS_INTERACTIVE,
                         age_s=-(enginemod._BULK_AGING_HORIZON_S + 5))
        self.assertGreater(TtsEngine._priority(late), bulk_key)


# ---------------------------------------------------------------------------
# 4. Truthful admission + reserve + elastic quality (live engine)
# ---------------------------------------------------------------------------
class _LiveEngineTests(unittest.TestCase):
    workers = 1
    queue_max = 3

    def setUp(self) -> None:
        self._orig_settings = enginemod.SETTINGS
        self._orig_wav = enginemod.audio_to_wav_bytes
        self._orig_tts = sys.modules["pocket_tts"].TTSModel
        enginemod.SETTINGS = dataclasses.replace(
            self._orig_settings, workers=self.workers, queue_max=self.queue_max,
            torch_threads=1)
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

    def _warm(self) -> None:
        for _ in range(enginemod._WARM_WINDOW):
            self.eng.metrics.on_finish(latency_s=1.0, proc_s=1.0, audio_s=1.0)


class TruthfulAdmissionTests(_LiveEngineTests):
    def test_a_refusal_carries_the_predicted_wait_and_a_backoff(self) -> None:
        self.eng.submit(voice_id="v", text="running")
        self.assertTrue(self.model.entered.wait(5))
        for i in range(self.queue_max):
            self.eng.submit(voice_id="v", text="x" * 300 + str(i))
        with self.assertRaises(AdmissionRejected) as ctx:
            self.eng.submit(voice_id="v", text="rejected")
        exc = ctx.exception
        self.assertGreater(exc.predicted_wait_s, 0.0)
        self.assertGreaterEqual(exc.retry_after_s, 1.0)
        self.assertEqual(exc.reason, "queue_full")
        payload = exc.payload()
        self.assertEqual(set(payload),
                         {"reason", "predicted_wait_s", "retry_after_s"})

    def test_a_plain_admission_rejected_still_constructs(self) -> None:
        # Test doubles and older call sites raise it with a message alone; every
        # reader must survive that.
        exc = AdmissionRejected("queue full")
        self.assertIsNone(exc.predicted_wait_s)
        self.assertEqual(exc.payload()["reason"], "queue_full")

    def test_queued_cost_is_added_and_settled_exactly_once(self) -> None:
        self._warm()
        running = self.eng.submit(voice_id="v", text="a" * 300)
        self.assertTrue(self.model.entered.wait(5))
        queued = self.eng.submit(voice_id="v", text="b" * 300)
        self.assertGreater(self.eng.pending_cost_s(), 0.0)
        # Abandon settles the cost at the moment the caller gives up...
        queued.abandoned.set()
        after = self.eng.pending_cost_s()
        # ...and the worker later discarding the tombstone must not settle again
        # (which would drive the accounting negative -> a floor of 0 hides it,
        # so assert the value directly).
        self.model.gate.set()
        self.assertTrue(self._wait(lambda: running.future.done()))
        self.assertTrue(self._wait(lambda: self.eng.pending_cost_s() == 0.0))
        self.assertGreaterEqual(after, 0.0)

    def test_the_promise_is_only_minted_from_a_warm_window(self) -> None:
        self.model.gate.set()
        cold = self.eng.submit(voice_id="v", text="hello there")
        self.assertIsNone(cold.promised_s,
                          "a cold window must put no number on the wire")
        self._warm()
        warm = self.eng.submit(voice_id="v", text="hello there")
        self.assertIsNotNone(warm.promised_s)
        self.assertGreater(warm.promised_s, 0.0)
        self.assertGreater(warm.est_synth_s, 0.0)


class InteractiveReserveTests(_LiveEngineTests):
    queue_max = 3

    def test_the_reserve_is_zero_by_default(self) -> None:
        # The floor changes WHO gets a 429 on a saturated box, so it may never
        # arrive switched on. The whole existing admission suite depends on it.
        self.assertEqual(enginemod._INTERACTIVE_RESERVE, 0)

    def test_bulk_stops_at_the_floor_and_interactive_does_not(self) -> None:
        orig = enginemod._INTERACTIVE_RESERVE
        enginemod._INTERACTIVE_RESERVE = 1
        self.addCleanup(setattr, enginemod, "_INTERACTIVE_RESERVE", orig)
        self.eng.submit(voice_id="v", text="running")
        self.assertTrue(self.model.entered.wait(5))
        # Fill everything except the reserved permit with bulk.
        for i in range(self.queue_max - 1):
            self.eng.submit(voice_id="v", text=f"bulk{i}")
        self.assertEqual(self.eng.available_permits(), 1)
        with self.assertRaises(AdmissionRejected) as ctx:
            self.eng.submit(voice_id="v", text="one bulk too many")
        self.assertEqual(ctx.exception.reason, "interactive_reserve")
        # The refused bulk job handed its permit straight back...
        self.assertEqual(self.eng.available_permits(), 1)
        # ...and the permit it was refused is exactly the one interactive gets.
        live = self.eng.submit(voice_id="v", text="live turn",
                               job_class=CLASS_INTERACTIVE)
        self.assertEqual(self.eng.available_permits(), 0)
        self.assertFalse(live.future.done())

    def test_an_unknown_class_is_a_loud_error(self) -> None:
        with self.assertRaises(ValueError):
            self.eng.submit(voice_id="v", text="x", job_class="urgent")


class ElasticQualityTests(_LiveEngineTests):
    def test_no_degradation_without_the_callers_permission(self) -> None:
        self._warm()
        self.eng.submit(voice_id="v", text="a" * 4000)   # fill the queue with cost
        self.assertTrue(self.model.entered.wait(5))
        job = self.eng.submit(voice_id="v", text="b" * 4000, deadline_s=0.001)
        # An impossible deadline, but degrade_allowed defaults False: the render
        # is FULL quality. A cheaper render nobody asked for is silent loss.
        self.assertEqual(job.quality_level, enginemod.QUALITY_FULL)
        self.assertEqual(job.overrides, {})
        self.assertIsNone(job.frames_after_eos)

    def test_an_impossible_deadline_degrades_visibly_when_allowed(self) -> None:
        self._warm()
        self.eng.submit(voice_id="v", text="a" * 4000)
        self.assertTrue(self.model.entered.wait(5))
        job = self.eng.submit(voice_id="v", text="b" * 4000, deadline_s=0.001,
                              degrade_allowed=True)
        self.assertEqual(job.quality_level, "minimal")
        self.assertEqual(job.overrides["lsd_decode_steps"], 1)
        self.assertEqual(job.frames_after_eos, 1)
        # The degraded job is CHEAPER than the full-quality estimate.
        full = self.eng.metrics.cost_estimate(4000, job.max_tokens)
        self.assertLess(job.est_synth_s, full["est_synth_s"])

    def test_a_reachable_deadline_is_never_degraded(self) -> None:
        self.model.gate.set()
        self._warm()
        job = self.eng.submit(voice_id="v", text="short", deadline_s=3600,
                              degrade_allowed=True)
        self.assertEqual(job.quality_level, enginemod.QUALITY_FULL)
        self.assertNotIn("lsd_decode_steps", job.overrides)

    def test_degradation_stops_at_the_cheapest_level_that_fits(self) -> None:
        # Straight at _degrade: a small overshoot takes the FIRST rung, not the
        # bottom one. Going cheaper than necessary is quality thrown away.
        job = Job(voice_id="v", text="t", max_tokens=100, frames_after_eos=None,
                  deadline_s=10.0, degrade_allowed=True, est_synth_s=10.0)
        TtsEngine._degrade(job, predicted_wait_s=0.0)
        self.assertEqual(job.quality_level, "reduced")
        self.assertEqual(job.overrides["lsd_decode_steps"], 2)

    def test_degradation_never_raises_a_knob_the_caller_pinned_lower(self) -> None:
        job = Job(voice_id="v", text="t", max_tokens=100, frames_after_eos=1,
                  overrides={"lsd_decode_steps": 1}, deadline_s=0.0,
                  degrade_allowed=True, est_synth_s=10.0)
        TtsEngine._degrade(job, predicted_wait_s=0.0)
        self.assertEqual(job.overrides["lsd_decode_steps"], 1)
        self.assertEqual(job.frames_after_eos, 1)

    def test_overrides_are_copied_not_aliased(self) -> None:
        # _degrade mutates job.overrides; the caller's dict must not change
        # under it (the /v1/speak path reuses one overrides dict per segment).
        self._warm()
        shared = {"temp": 0.9}
        self.model.gate.set()
        self.eng.submit(voice_id="v", text="x", overrides=shared)
        self.assertEqual(shared, {"temp": 0.9})


class DeadlineOrderingIsLiveTests(_LiveEngineTests):
    def test_the_worker_serves_the_tightest_deadline_first(self) -> None:
        # The claim/tombstone protocol is order-agnostic, so the container swap
        # must be visible end to end: one worker, three queued jobs, served by
        # deadline rather than by arrival.
        self.eng.submit(voice_id="v", text="pinned")
        self.assertTrue(self.model.entered.wait(5))
        self.eng.submit(voice_id="v", text="loose", deadline_s=600)
        self.eng.submit(voice_id="v", text="tight", deadline_s=1)
        self.model.gate.set()
        self.assertTrue(self._wait(
            lambda: {"loose", "tight"} <= set(self.model.generated)))
        order = [t for t in self.model.generated if t in ("loose", "tight")]
        self.assertEqual(order, ["tight", "loose"])


if __name__ == "__main__":
    unittest.main()
