"""The expensive path gets a budget, and the ledger survives the process.

The ingest router shipped behind `require_scope("clone")` and nothing else,
while the CHEAP single-stem clone on /v1/voices carried a demo budget. One
`POST /v1/ingest/scan` is two duration-billed ElevenLabs calls, five to eight
Gemini calls and a torch model load; one valid key could run them back to back.

`_admit` was not that budget: it bounds concurrency and releases the moment a
scan finishes, so a client that waits its turn spends without limit.

And the per-job spend ledger lived in `_SPEND`, which is per PROCESS — so a job
rehydrated after a restart, or adopted from a dead replica, was handed a brand
new retry/escalation budget against the same paid providers.
"""
from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi import HTTPException

from service import ingest, ingest_api, ratelimit


class BudgetShapeTests(unittest.TestCase):
    def test_both_expensive_routes_have_a_named_budget(self) -> None:
        self.assertIn("ingest-scan", ratelimit.BUDGETS)
        self.assertIn("ingest-audition", ratelimit.BUDGETS)

    def test_the_scan_budget_is_demo_sized(self) -> None:
        limiter = ratelimit.BUDGETS["ingest-scan"]
        self.assertEqual((limiter.limit, limiter.window_s, limiter.burst),
                         (12, 600.0, 3))

    def test_the_audition_budget_is_looser_than_the_scan_budget(self) -> None:
        # An audition is local CPU synthesis on a finished scan; the whole
        # feature is worthless if it is rationed like a cloud scan.
        self.assertGreater(ratelimit.BUDGETS["ingest-audition"].limit,
                           ratelimit.BUDGETS["ingest-scan"].limit)

    def test_the_limits_are_env_tunable(self) -> None:
        with mock.patch.dict(os.environ, {"TTS_BUDGET_INGEST_SCAN": "3"}):
            self.assertEqual(ingest_api._budget_limit("TTS_BUDGET_INGEST_SCAN", 12), 3)
        with mock.patch.dict(os.environ, {"TTS_BUDGET_INGEST_SCAN": "nonsense"}):
            self.assertEqual(ingest_api._budget_limit("TTS_BUDGET_INGEST_SCAN", 12), 12)

    def test_the_routes_actually_carry_the_dependency(self) -> None:
        wanted = {"/v1/ingest/scan": "ingest-scan",
                  "/v1/ingest/{job_id}/audition": "ingest-audition"}
        found: dict[str, list[str]] = {}
        for route in ingest_api.router.routes:
            names = [getattr(d.dependency, "budget_name", None)
                     for d in getattr(route, "dependencies", [])]
            found[getattr(route, "path", "")] = [n for n in names if n]
        for path, budget in wanted.items():
            self.assertIn(budget, found.get(path, []),
                          f"{path} carries no per-IP budget")
        # ...and the progress poller does NOT: refusing the poller for the scan
        # it is watching would be worse than no budget at all.
        self.assertEqual(found.get("/v1/ingest/{job_id}"), [])

    def test_the_429_quotes_the_real_effective_budget(self) -> None:
        # `describe()` is what makes a 429 honest about the topology — with N
        # replicas and no shared window the pool allows N times the number.
        dep = ratelimit.per_ip_budget("ingest-scan-test", limit=2, window_s=60,
                                      burst=2, shared=False, replicas=4)
        bypass = os.environ.pop("GRAVITONE_RATELIMIT_TEST_BYPASS", None)
        try:
            request = mock.Mock(method="POST",
                                client=mock.Mock(host="10.0.0.9"), headers={})
            dep(request)
            dep(request)
            with self.assertRaises(HTTPException) as ctx:
                dep(request)
        finally:
            if bypass is not None:
                os.environ["GRAVITONE_RATELIMIT_TEST_BYPASS"] = bypass
            ratelimit.BUDGETS.pop("ingest-scan-test", None)
        detail = ctx.exception.detail
        self.assertEqual(ctx.exception.status_code, 429)
        self.assertIn("PER REPLICA", detail)
        self.assertIn("up to 8", detail)
        self.assertIn("Retry in", detail)


def _job(root: Path, jid: str = "s1", status: str = "running") -> dict:
    wd = root / jid
    wd.mkdir(parents=True, exist_ok=True)
    return {"id": jid, "status": status, "step": None, "mode": "cloud",
            "steps": [], "partial": {}, "speakers": None, "duration": 0,
            "result": None, "error": None, "work_dir": str(wd),
            "created": 0.0, "clip_sha256": "abc", "cancel": False,
            "committed": None}


class PersistedSpendTests(unittest.TestCase):
    def setUp(self) -> None:
        self._jobs = dict(ingest_api.JOBS)
        self._spend = dict(ingest_api._SPEND)
        ingest_api.JOBS.clear()
        ingest_api._SPEND.clear()

    def tearDown(self) -> None:
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._jobs)
        ingest_api._SPEND.clear()
        ingest_api._SPEND.update(self._spend)

    def test_the_ledger_is_written_into_the_state_file(self) -> None:
        with TemporaryDirectory() as td:
            job = _job(Path(td))
            ingest_api.JOBS["s1"] = job
            led = ingest_api._spend_for("s1")
            led.charge("elevenlabs")
            led.take_retry()
            ingest_api._persist(job)
            state = json.loads(
                (Path(job["work_dir"]) / "state.json").read_text("utf-8"))
        self.assertEqual(state["spend"]["calls"]["elevenlabs"], 1)
        self.assertEqual(state["spend"]["retries"], 1)

    def test_a_rehydrated_job_cannot_mint_a_fresh_retry_budget(self) -> None:
        """THE property. `_SPEND` is per process; `state.json` is not."""
        with TemporaryDirectory() as td:
            root = Path(td)
            job = _job(root)
            ingest_api.JOBS["s1"] = job
            led = ingest_api._spend_for("s1")
            for _ in range(led.retry_budget):
                self.assertTrue(led.take_retry())
            self.assertFalse(led.take_retry(), "the budget should be spent")
            ingest_api._persist(job)

            # ...the process dies, or the job is adopted by another replica.
            ingest_api.JOBS.clear()
            ingest_api._SPEND.clear()
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                ingest_api._rehydrate()
            resumed = ingest_api._spend_for("s1")
        self.assertEqual(resumed.retries, resumed.retry_budget)
        self.assertFalse(resumed.take_retry(),
                         "a rehydrated job minted itself a fresh retry budget")

    def test_escalations_resume_too(self) -> None:
        with TemporaryDirectory() as td:
            job = _job(Path(td))
            ingest_api.JOBS["s1"] = job
            led = ingest_api._spend_for("s1")
            self.assertEqual(led.take_escalations(led.escalation_budget),
                             led.escalation_budget)
            ingest_api._persist(job)
            ingest_api._SPEND.clear()
            resumed = ingest_api._spend_for("s1")
            self.assertEqual(resumed.take_escalations(1), 0)

    def test_a_fresh_job_starts_at_zero(self) -> None:
        with TemporaryDirectory() as td:
            ingest_api.JOBS["s1"] = _job(Path(td))
            led = ingest_api._spend_for("s1")
            self.assertEqual(led.snapshot()["total_calls"], 0)
            self.assertEqual(led.retries, 0)


class SpendRestoreTests(unittest.TestCase):
    def test_restore_round_trips_a_snapshot(self) -> None:
        led = ingest.Spend()
        led.charge("gemini")
        led.charge("gemini")
        led.take_retry()
        led.note_escalation_failure(1)
        clone = ingest.Spend()
        clone.restore(led.snapshot())
        self.assertEqual(clone.snapshot()["calls"], {"gemini": 2})
        self.assertEqual(clone.retries, 1)
        self.assertEqual(clone.escalations_failed, 1)

    def test_restore_ignores_junk_and_never_raises(self) -> None:
        led = ingest.Spend()
        led.restore({"calls": "not a dict", "retries": None,
                     "escalated": True, "escalations_skipped": -4})
        self.assertEqual(led.calls, {})
        self.assertEqual(led.retries, 0)
        self.assertEqual(led.escalated, 0)
        self.assertEqual(led.escalations_skipped, 0)

    def test_restore_does_not_reinstate_an_old_cap(self) -> None:
        # Budgets come from settings, so lowering a cap applies to jobs already
        # in flight rather than being overwritten by a persisted number.
        led = ingest.Spend(retry_budget=3)
        led.restore({"retries": 1, "retry_budget": 999})
        self.assertEqual(led.retry_budget, 3)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
