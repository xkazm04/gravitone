"""The deadline contract reaches EVERY synthesis route, not just one branch.

``deadline_s``/``degrade_allowed`` used to reach ``engine.submit`` from exactly
one place: the single-unit branch of /v1/text-to-speech. The multi-unit branch
of the SAME endpoint dropped them, as did /v1/speak, /v1/performance, the
streaming route and /v1/build — so whether a caller's deadline was honoured
depended on how long their text was.

Every case here drives a REAL route and asserts a BEHAVIOUR the deadline caused,
never that a keyword was plumbed:

* the fake pool is a priority queue keyed by the production
  ``TtsEngine._priority``, so "the tight deadline was served first" is an
  observation of ordering;
* the fake walks the production elastic-quality ladder, so a degraded request
  really renders more cheaply and reports ``X-Quality-Level``;
* an unmeetable deadline lands in ``FakeEngine.unfittable`` — the route asked,
  and the engine answered honestly.

Delete the wiring from any one route and that route's case fails.
"""
from __future__ import annotations

import dataclasses
import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod  # noqa: E402
import service.engine as enginemod  # noqa: E402

_EMAP = {"baseline": "v_base", "happy": "v_happy", "sad": "v_sad"}


class _RouteCase(unittest.TestCase):
    """Fake engine + fake emotion map, SETTINGS restored between cases."""

    def setUp(self) -> None:
        self._orig_engine = appmod.ENGINE
        self._orig_emap = appmod.emotion_map
        self._orig_settings = appmod.SETTINGS
        appmod.emotion_map = lambda cid: dict(_EMAP)
        from fastapi.testclient import TestClient
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        eng = appmod.ENGINE
        if isinstance(eng, fake_engine.FakeEngine):
            eng.close()
        appmod.ENGINE = self._orig_engine
        appmod.emotion_map = self._orig_emap
        appmod.SETTINGS = self._orig_settings

    def _configure(self, **kw) -> None:
        appmod.SETTINGS = dataclasses.replace(appmod.SETTINGS, **kw)

    def _engine(self, **kw) -> fake_engine.FakeEngine:
        eng = fake_engine.FakeEngine(**kw)
        appmod.ENGINE = eng
        return eng

    # A deadline no render can meet at full quality (the fake's delay is 0.1s
    # per segment), but which the "minimal" rung (×0.5) CAN meet.
    TIGHT = 0.06
    IMPOSSIBLE = 0.001

    def assertDegraded(self, eng: fake_engine.FakeEngine) -> None:
        self.assertTrue(eng.jobs, "the route submitted nothing")
        self.assertTrue(any(j.quality_level != "full" for j in eng.jobs),
                        "no job was degraded: the route dropped the caller's "
                        "deadline/degrade_allowed on the way to submit()")

    def assertCarriedDeadline(self, eng: fake_engine.FakeEngine) -> None:
        self.assertTrue(all(j.deadline_s is not None for j in eng.jobs),
                        "a job reached the engine with no deadline at all")


# ---------------------------------------------------------------------------
# /v1/text-to-speech — BOTH branches, which is the whole point
# ---------------------------------------------------------------------------
class DropInRouteTests(_RouteCase):

    def _post(self, text: str, **extra):
        return self.client.post("/v1/text-to-speech/alba",
                                json={"text": text, **extra})

    def test_the_single_unit_branch_still_honours_the_deadline(self) -> None:
        self._configure(workers=1)
        eng = self._engine(workers=1, delay=0.1)
        resp = self._post("One short line.", deadline_s=self.TIGHT,
                          degrade_allowed=True)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(eng.jobs), 1)
        self.assertDegraded(eng)
        self.assertEqual(resp.headers["x-quality-level"], "minimal")

    def test_the_multi_unit_branch_honours_it_too(self) -> None:
        # THE BUG: this branch dropped deadline_s entirely, so an identical
        # request was scheduled differently purely because its text was longer.
        # chunk_chars small enough that the sentences do NOT coalesce back
        # into one unit (_chunk_text merges neighbours up to the budget).
        self._configure(workers=4, chunk_chars=24)
        eng = self._engine(workers=4, delay=0.1)
        text = ("Sentence one is here. Sentence two is here. "
                "Sentence three is here. Sentence four is here.")
        resp = self._post(text, deadline_s=self.TIGHT, degrade_allowed=True)
        self.assertEqual(resp.status_code, 200)
        self.assertGreater(len(eng.jobs), 1, "this case needs >1 unit")
        self.assertCarriedDeadline(eng)
        self.assertDegraded(eng)
        self.assertEqual(resp.headers["x-quality-level"], "minimal")

    def test_every_unit_inherits_the_whole_request_horizon(self) -> None:
        # The documented multi-unit semantic: one horizon, not a 1/N slice.
        self._configure(workers=4, chunk_chars=24)
        eng = self._engine(workers=4, delay=0.1)
        self._post("Sentence one is here. Sentence two is here. "
                   "Sentence three is here.", deadline_s=30.0)
        self.assertGreater(len(eng.jobs), 1)
        self.assertEqual({j.deadline_s for j in eng.jobs}, {30.0})

    def test_a_request_with_no_deadline_names_none(self) -> None:
        # The no-change pin: absent deadline == the pre-deadline call.
        self._configure(workers=4, chunk_chars=24)
        eng = self._engine(workers=4, delay=0.02)
        self._post("Sentence one is here. Sentence two is here.")
        self.assertTrue(eng.jobs)
        self.assertTrue(all(j.deadline_s is None and j.quality_level == "full"
                            for j in eng.jobs))
        self.assertEqual(eng.unfittable, [])

    def test_the_tight_deadline_is_served_first(self) -> None:
        """Ordering, end to end: two requests, one worker, tightest first.

        The pool is paused so both land in the queue before either is served;
        the loose request is submitted FIRST, so arrival order and deadline
        order disagree and only the deadline can explain the result.
        """
        import threading
        self._configure(workers=1)
        eng = self._engine(workers=1, delay=0.01, paused=True)
        done = threading.Event()

        def _loose() -> None:
            self.client.post("/v1/text-to-speech/alba",
                             json={"text": "loose one.", "deadline_s": 600})
            done.set()

        t = threading.Thread(target=_loose, daemon=True)
        t.start()
        self.assertTrue(_wait(lambda: len(eng.jobs) == 1))
        t2 = threading.Thread(
            target=lambda: self.client.post(
                "/v1/text-to-speech/alba",
                json={"text": "tight one.", "deadline_s": 3}), daemon=True)
        t2.start()
        self.assertTrue(_wait(lambda: len(eng.jobs) == 2))
        eng.resume()
        self.assertTrue(_wait(lambda: len(eng.executed) == 2))
        self.assertEqual(eng.executed, ["tight one.", "loose one."])
        t.join(timeout=5)
        t2.join(timeout=5)


# ---------------------------------------------------------------------------
# /v1/speak and /v1/performance (the wave paths)
# ---------------------------------------------------------------------------
class SpeakRouteTests(_RouteCase):

    def test_speak_carries_the_deadline_into_every_wave(self) -> None:
        self._configure(workers=1)   # 1 worker => one segment per wave
        eng = self._engine(workers=1, delay=0.1)
        resp = self.client.post(
            "/v1/speak",
            json={"character_id": "sarah",
                  "text": "[happy]Hello[/happy] [sad]World",
                  "deadline_s": self.TIGHT, "degrade_allowed": True})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(eng.jobs), 2)
        self.assertCarriedDeadline(eng)
        self.assertDegraded(eng)
        self.assertEqual(resp.headers["x-quality-level"], "minimal")

    def test_a_later_wave_gets_the_REMAINING_horizon(self) -> None:
        # deadline_s means "seconds from admission"; re-sending the caller's
        # original number on a wave submitted later would silently extend it.
        self._configure(workers=1)
        eng = self._engine(workers=1, delay=0.15)
        self.client.post(
            "/v1/speak",
            json={"character_id": "sarah",
                  "text": "[happy]Hello[/happy] [sad]World",
                  "deadline_s": 30.0})
        self.assertEqual(len(eng.jobs), 2)
        self.assertAlmostEqual(eng.jobs[0].deadline_s, 30.0, places=1)
        self.assertLess(eng.jobs[1].deadline_s, eng.jobs[0].deadline_s)

    def test_speak_without_a_deadline_is_unchanged(self) -> None:
        self._configure(workers=2)
        eng = self._engine(workers=2, delay=0.02)
        resp = self.client.post(
            "/v1/speak",
            json={"character_id": "sarah",
                  "text": "[happy]Hello[/happy] [sad]World"})
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn("x-quality-level", resp.headers)
        self.assertTrue(all(j.deadline_s is None for j in eng.jobs))


class PerformanceRouteTests(_RouteCase):

    def test_performance_carries_the_deadline(self) -> None:
        self._configure(workers=2)
        eng = self._engine(workers=2, delay=0.1)
        resp = self.client.post(
            "/v1/performance",
            json={"lines": [{"character_id": "sarah", "text": "Line one."},
                            {"character_id": "sarah", "text": "Line two."}],
                  "deadline_s": self.TIGHT, "degrade_allowed": True})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(eng.jobs), 2)
        self.assertCarriedDeadline(eng)
        self.assertDegraded(eng)
        self.assertEqual(resp.headers["x-quality-level"], "minimal")

    def test_an_unmeetable_deadline_is_recorded_not_degraded(self) -> None:
        self._configure(workers=2)
        eng = self._engine(workers=2, delay=0.1)
        resp = self.client.post(
            "/v1/performance",
            json={"lines": [{"character_id": "sarah", "text": "Line one."}],
                  "deadline_s": self.IMPOSSIBLE, "degrade_allowed": True})
        self.assertEqual(resp.status_code, 200)
        # No rung fits: full quality plus a recorded miss, not the cheapest
        # audio AND a missed deadline.
        self.assertEqual(eng.unfittable, ["Line one."])
        self.assertTrue(all(j.quality_level == "full" for j in eng.jobs))
        self.assertNotIn("x-quality-level", resp.headers)


# ---------------------------------------------------------------------------
# The streaming route
# ---------------------------------------------------------------------------
class StreamRouteTests(_RouteCase):

    def test_the_stream_carries_the_deadline_into_its_window(self) -> None:
        self._configure(workers=2, chunk_chars=24)
        eng = self._engine(workers=2, delay=0.1)
        with self.client.stream(
            "POST", "/v1/text-to-speech/alba/stream?output_format=pcm_24000",
            json={"text": "Sentence one is here. Sentence two is here.",
                  "deadline_s": self.TIGHT, "degrade_allowed": True},
        ) as resp:
            self.assertEqual(resp.status_code, 200)
            body = b"".join(resp.iter_bytes())
        self.assertTrue(body)
        self.assertTrue(eng.jobs)
        self.assertCarriedDeadline(eng)
        self.assertDegraded(eng)

    def test_later_stream_segments_get_the_remaining_horizon(self) -> None:
        # Window of 1 => segment 2 is submitted only after segment 1 is
        # consumed, i.e. genuinely later in wall-clock time.
        self._configure(workers=1, stream_window=2, chunk_chars=24)
        eng = self._engine(workers=1, delay=0.15)
        with self.client.stream(
            "POST", "/v1/text-to-speech/alba/stream?output_format=pcm_24000",
            json={"text": "Sentence one is here. Sentence two is here. "
                          "Sentence three is here.",
                  "deadline_s": 30.0},
        ) as resp:
            b"".join(resp.iter_bytes())
        self.assertGreaterEqual(len(eng.jobs), 3)
        self.assertAlmostEqual(eng.jobs[0].deadline_s, 30.0, places=1)
        # The rolled-in third segment was submitted after the first was
        # consumed: it gets what is LEFT of the horizon, not a fresh 30s.
        self.assertLess(eng.jobs[2].deadline_s, eng.jobs[0].deadline_s)

    def test_a_stream_with_no_deadline_is_unchanged(self) -> None:
        self._configure(workers=2, chunk_chars=24)
        eng = self._engine(workers=2, delay=0.02)
        with self.client.stream(
            "POST", "/v1/text-to-speech/alba/stream?output_format=pcm_24000",
            json={"text": "Sentence one is here. Sentence two is here."},
        ) as resp:
            b"".join(resp.iter_bytes())
        self.assertTrue(all(j.deadline_s is None for j in eng.jobs))


# ---------------------------------------------------------------------------
# /v1/build
# ---------------------------------------------------------------------------
class BuildRouteTests(_RouteCase):

    def setUp(self) -> None:
        super().setUp()
        import tempfile
        from service import buildstore
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._orig_store = appmod.BUILD_STORE
        appmod.BUILD_STORE = buildstore.BuildStore(root=self._tmp.name)
        self.addCleanup(lambda: setattr(appmod, "BUILD_STORE",
                                        self._orig_store))

    def test_the_manifests_deadline_reaches_every_line(self) -> None:
        self._configure(workers=1)
        eng = self._engine(workers=1, delay=0.05)
        resp = self.client.post("/v1/build", json={
            "lines": [{"id": "a", "voice": "alba", "text": "Deadline line A."},
                      {"id": "b", "voice": "alba", "text": "Deadline line B."}],
            "deadline_s": 12.0})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(len(eng.jobs), 2)
        # A PER-LINE horizon: each line is scheduled against the same number.
        self.assertEqual({j.deadline_s for j in eng.jobs}, {12.0})

    def test_degrade_is_refused_rather_than_ignored(self) -> None:
        self._configure(workers=1)
        self._engine(workers=1, delay=0.01)
        resp = self.client.post("/v1/build", json={
            "lines": [{"id": "a", "voice": "alba", "text": "Refused line."}],
            "deadline_s": 5.0, "degrade_allowed": True})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("digest", resp.json()["detail"])

    def test_a_manifest_with_no_deadline_is_unchanged(self) -> None:
        self._configure(workers=1)
        eng = self._engine(workers=1, delay=0.01)
        resp = self.client.post("/v1/build", json={
            "lines": [{"id": "a", "voice": "alba", "text": "Plain line."}]})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(len(eng.jobs), 1)
        self.assertTrue(all(j.deadline_s is None for j in eng.jobs))


# ---------------------------------------------------------------------------
# The priority floor: deadline_s is not a free escalation
# ---------------------------------------------------------------------------
class DeadlineFloorTests(unittest.TestCase):
    """An unauthenticated body field must not outrank the interactive class."""

    @staticmethod
    def _job(text, deadline_s=None, job_class=enginemod.CLASS_BULK, stamp=0.0):
        return enginemod.Job(voice_id="v", text=text, max_tokens=1,
                             frames_after_eos=None, deadline_s=deadline_s,
                             job_class=job_class, t_enqueue=stamp)

    def test_a_bulk_deadline_cannot_outrank_interactive(self) -> None:
        greedy = self._job("greedy", deadline_s=0.001)
        live = self._job("live", job_class=enginemod.CLASS_INTERACTIVE)
        # At worst a TIE (seq breaks it by arrival) — never ahead.
        self.assertGreaterEqual(enginemod.TtsEngine._priority(greedy),
                                enginemod.TtsEngine._priority(live))

    def test_a_bulk_deadline_cannot_beat_the_aging_bound(self) -> None:
        # A bulk job that has aged past (BULK - INTERACTIVE) still wins, which
        # is exactly the starvation bound the floor protects.
        aged = self._job("aged", stamp=-(enginemod._BULK_AGING_HORIZON_S
                                         - enginemod._INTERACTIVE_HORIZON_S + 1))
        greedy = self._job("greedy", deadline_s=0.001)
        self.assertLess(enginemod.TtsEngine._priority(aged),
                        enginemod.TtsEngine._priority(greedy))

    def test_interactive_may_tighten_within_its_own_class(self) -> None:
        urgent = self._job("urgent", deadline_s=0.001,
                           job_class=enginemod.CLASS_INTERACTIVE)
        plain = self._job("plain", job_class=enginemod.CLASS_INTERACTIVE)
        self.assertLess(enginemod.TtsEngine._priority(urgent),
                        enginemod.TtsEngine._priority(plain))
        # ...but never to zero: the floor is the tightest key money can buy.
        self.assertAlmostEqual(enginemod.TtsEngine._priority(urgent),
                               enginemod._INTERACTIVE_DEADLINE_FLOOR_S, 6)

    def test_a_loose_deadline_is_untouched(self) -> None:
        job = self._job("loose", deadline_s=45.0)
        self.assertAlmostEqual(enginemod.TtsEngine._priority(job), 45.0, 6)

    def test_the_floor_never_edits_the_callers_number(self) -> None:
        # The clamp lives in the queue key ONLY: the degrade decision, the
        # promise and the hit measurement are all made against what the caller
        # actually asked for.
        job = self._job("greedy", deadline_s=0.001)
        enginemod.TtsEngine._priority(job)
        self.assertEqual(job.deadline_s, 0.001)


def _wait(pred, timeout: float = 5.0) -> bool:
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.01)
    return False


if __name__ == "__main__":
    unittest.main()
