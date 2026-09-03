"""A shutdown must not orphan a commit — and a rebuild must not vanish.

Three failures, one theme: the process stopping was not part of the design.

  * the lifespan drained ENGINE and nothing else. Ingest's phase threads
    (analyze, label, commit, rederive, the GC sweeper) were daemons nobody
    joined and nothing could wake — the sweeper slept five minutes at a time.
  * SIGTERM mid-commit left rows already registered through `mutate_meta`
    while `_rollback` was still ten lines away, and the next boot relabelled
    the job "interrupted by restart" without undoing anything. A partial
    Character survived, unnoticed.
  * a cancelled re-derivation KEEPS the voices it rebuilt (deliberately — it
    replaced voices that no longer exist), but `cancel_job` popped the job and
    rmtree'd its workdir first, so that list survived only in a server log
    while the API answered {"status": "cancelled"}.
"""
from __future__ import annotations

import json
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service import ingest_api


def _job(root: Path, jid: str, status: str, mode: str = "sovereign") -> dict:
    wd = root / jid
    wd.mkdir(parents=True, exist_ok=True)
    return {"id": jid, "status": status, "step": None, "mode": mode,
            "steps": [], "partial": {}, "speakers": None, "duration": 0,
            "result": None, "error": None, "work_dir": str(wd),
            "created": time.time(), "clip_sha256": "abc", "cancel": False,
            "committed": None, "character_id": "ada"}


class _JobsIsolated(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()

    def tearDown(self) -> None:
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._orig)


class DrainTests(_JobsIsolated):
    def setUp(self) -> None:
        super().setUp()
        with ingest_api._LOCK:
            ingest_api._PHASES.clear()
        ingest_api._STOP.clear()

    def tearDown(self) -> None:
        super().tearDown()
        ingest_api._STOP.clear()
        with ingest_api._LOCK:
            ingest_api._PHASES.clear()
        ingest_api._started = False
        ingest_api._gc_thread = None

    def test_the_sweeper_wakes_on_the_stop_event(self) -> None:
        """`_GC_INTERVAL` is five minutes. A drain that waited for the sleep
        would be a hang, so the loop waits on the EVENT, not on the clock."""
        with TemporaryDirectory() as td:
            with mock.patch.object(ingest_api, "WORK_ROOT", Path(td)):
                ingest_api._started = False
                ingest_api.start_background()
                gc = ingest_api._gc_thread
                self.assertIsNotNone(gc)
                started = time.monotonic()
                report = ingest_api.stop_background(grace=5.0)
                self.assertLess(time.monotonic() - started, 3.0,
                                "the sweeper did not wake on the stop event")
                self.assertFalse(gc.is_alive())
                self.assertTrue(report["gc_stopped"])

    def test_a_clean_stop_releases_this_processs_ownership(self) -> None:
        with TemporaryDirectory() as td:
            with mock.patch.object(ingest_api, "WORK_ROOT", Path(td)):
                ingest_api._started = False
                ingest_api.start_background()
                self.assertTrue(ingest_api._beat_path().is_file())
                ingest_api.stop_background(grace=5.0)
                self.assertFalse(ingest_api._beat_path().exists())

    def test_a_phase_that_finishes_inside_the_grace_is_waited_for(self) -> None:
        finished = threading.Event()

        def _phase() -> None:
            time.sleep(0.2)
            finished.set()

        ingest_api._spawn(_phase, (), "ingest-test-fast")
        report = ingest_api.stop_background(grace=5.0)
        self.assertTrue(finished.is_set(), "drain returned before the phase did")
        self.assertEqual(report["unfinished"], [])

    def test_a_phase_that_outruns_the_grace_is_reported_not_hidden(self) -> None:
        release = threading.Event()
        ingest_api._spawn(lambda: release.wait(30), (), "ingest-test-slow")
        try:
            with self.assertLogs("gravitone", level="WARNING") as logs:
                report = ingest_api.stop_background(grace=0.3)
            self.assertEqual(report["unfinished"], ["ingest-test-slow"])
            self.assertIn("ingest-test-slow", "\n".join(logs.output))
        finally:
            release.set()

    def test_start_after_stop_is_allowed(self) -> None:
        # A drain that could not be undone would make the lifespan single-use,
        # and the stop event would stay set for the next process's sweeper.
        with TemporaryDirectory() as td:
            with mock.patch.object(ingest_api, "WORK_ROOT", Path(td)):
                ingest_api._started = False
                ingest_api.start_background()
                ingest_api.stop_background(grace=5.0)
                ingest_api.start_background()
                self.assertFalse(ingest_api._STOP.is_set())
                self.assertTrue(ingest_api._gc_thread.is_alive())
                ingest_api.stop_background(grace=5.0)


class StartupReconciliationTests(_JobsIsolated):
    def _committing(self, root: Path, journal: dict | None) -> dict:
        job = _job(root, "c1", "committing")
        ingest_api._persist(job)
        if journal is not None:
            ingest_api._write_journal(Path(job["work_dir"]), journal)
        return job

    def test_a_partial_clone_is_rolled_back_at_startup(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                self._committing(root, {
                    "kind": "commit", "state": "running", "job_id": "c1",
                    "intended": ["happy", "sad"],
                    "registered": [{"voice_id": "v-happy", "emotion": "happy"}]})
                with mock.patch.object(ingest_api.voices, "remove_voices",
                                       return_value=["v-happy"]) as rm:
                    ingest_api._rehydrate()
            rm.assert_called_once_with(["v-happy"])
            job = ingest_api.JOBS["c1"]
            self.assertEqual(job["status"], "error")
            self.assertIn("removed", job["error"])
            # ...and the journal is gone, so a second boot does not re-undo it.
            self.assertIsNone(ingest_api._read_journal(Path(job["work_dir"])))

    def test_a_finished_clone_is_marked_committed_not_destroyed(self) -> None:
        # The status flip is the LAST thing a commit does. A crash between the
        # last registration and that flip must not be read as "half a
        # character" — rolling back a complete, consented clone would be the
        # same bug pointed the other way.
        with TemporaryDirectory() as td:
            root = Path(td)
            made = [{"voice_id": "v-happy", "emotion": "happy"},
                    {"voice_id": "v-sad", "emotion": "sad"}]
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                self._committing(root, {
                    "kind": "commit", "state": "running", "job_id": "c1",
                    "intended": ["happy", "sad"], "registered": made})
                with mock.patch.object(ingest_api.voices, "remove_voices") as rm:
                    ingest_api._rehydrate()
            rm.assert_not_called()
            job = ingest_api.JOBS["c1"]
            self.assertEqual(job["status"], "committed")
            self.assertEqual(job["committed"], made)
            self.assertIsNone(job["error"])

    def test_the_done_marker_alone_completes_the_job(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                self._committing(root, {
                    "kind": "commit", "state": "done", "job_id": "c1",
                    "intended": ["happy"],
                    "registered": [{"voice_id": "v-happy", "emotion": "happy"}]})
                with mock.patch.object(ingest_api.voices, "remove_voices") as rm:
                    ingest_api._rehydrate()
            rm.assert_not_called()
            self.assertEqual(ingest_api.JOBS["c1"]["status"], "committed")

    def test_a_phase_with_no_journal_still_just_errors(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                job = _job(root, "r1", "running")
                ingest_api._persist(job)
                with mock.patch.object(ingest_api.voices, "remove_voices") as rm:
                    ingest_api._rehydrate()
            rm.assert_not_called()
            self.assertEqual(ingest_api.JOBS["r1"]["status"], "error")
            self.assertEqual(ingest_api.JOBS["r1"]["error"],
                             "interrupted by restart")

    def test_an_interrupted_rederive_is_never_rolled_back(self) -> None:
        # A rebuild REPLACED voices that no longer exist. Removing the rebuilt
        # one leaves the character with nothing for that emotion — strictly
        # worse. It is reported, and the report outlives the job.
        with TemporaryDirectory() as td:
            root = Path(td)
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                job = _job(root, "rd1", "committing", mode="rederive")
                ingest_api._persist(job)
                ingest_api._write_journal(Path(job["work_dir"]), {
                    "kind": "rederive", "state": "running", "job_id": "rd1",
                    "character_id": "ada", "intended": ["happy"],
                    "registered": [{"voice_id": "v-happy", "emotion": "happy"}]})
                with mock.patch.object(ingest_api.voices, "remove_voices") as rm:
                    ingest_api._rehydrate()
                rm.assert_not_called()
                out = ingest_api.JOBS["rd1"]
                self.assertEqual(out["status"], "error")
                self.assertIn("KEPT", out["error"])
                receipt = ingest_api._read_receipt("rd1")
            self.assertEqual(receipt["rederive"]["outcome"], "interrupted")
            self.assertTrue(receipt["rederive"]["kept"])
            self.assertEqual([v["voice_id"] for v in receipt["rederive"]["voices"]],
                             ["v-happy"])


class RederiveReceiptTests(_JobsIsolated):
    def test_a_cancelled_rebuild_can_still_be_read_back(self) -> None:
        """The receipt survives the job, the workdir and the pop.

        `cancel_job` lands in the middle of the rebuild here, exactly as it
        does in production: it pops the job from JOBS and deletes the workdir
        while the phase thread is between voices.
        """
        with TemporaryDirectory() as td:
            root = Path(td)
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                job = _job(root, "rd2", "committing", mode="rederive")
                ingest_api.JOBS["rd2"] = job

                def fake_rederive(cid, work_dir, emotions, *, progress=None,
                                  should_cancel=None, on_voice=None):
                    on_voice({"voice_id": "v-happy", "emotion": "happy",
                              "replaced": "v-happy-old"})
                    # The DELETE arrives now.
                    resp = ingest_api.cancel_job("rd2")
                    self.assertEqual(resp["status"], "cancelled")
                    self.assertTrue(resp["kept"])
                    self.assertEqual([v["voice_id"] for v in resp["rebuilt"]],
                                     ["v-happy"])
                    raise ingest_api.ingest.Cancelled()

                with mock.patch.object(ingest_api.ingest, "rederive",
                                       side_effect=fake_rederive):
                    ingest_api._do_rederive("rd2", "ada", None)

                self.assertNotIn("rd2", ingest_api.JOBS)
                self.assertFalse((root / "rd2").exists())
                payload = ingest_api.get_job("rd2")
            self.assertEqual(payload["rederive"]["outcome"], "cancelled")
            self.assertTrue(payload["rederive"]["kept"])
            self.assertEqual(payload["rederive"]["voices"],
                             [{"voice_id": "v-happy", "emotion": "happy",
                               "replaced": "v-happy-old"}])

    def test_a_completed_rebuild_leaves_a_receipt_too(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                job = _job(root, "rd3", "committing", mode="rederive")
                ingest_api.JOBS["rd3"] = job

                def fake_rederive(cid, work_dir, emotions, *, progress=None,
                                  should_cancel=None, on_voice=None):
                    v = {"voice_id": "v-sad", "emotion": "sad",
                         "replaced": "v-sad-old"}
                    on_voice(v)
                    return {"created": [v], "stems": [{"emotion": "sad"}]}

                with mock.patch.object(ingest_api.ingest, "rederive",
                                       side_effect=fake_rederive):
                    ingest_api._do_rederive("rd3", "ada", None)
                self.assertEqual(job["status"], "committed")
                ingest_api.JOBS.pop("rd3")
                payload = ingest_api.get_job("rd3")
            self.assertEqual(payload["rederive"]["outcome"], "completed")
            self.assertEqual([v["voice_id"] for v in payload["rederive"]["voices"]],
                             ["v-sad"])

    def test_a_terminal_receipt_is_never_downgraded(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                job = _job(root, "rd4", "cancelled", mode="rederive")
                ingest_api._record_rederive(job, "cancelled", [])
                # A straggling progress write from the phase thread.
                ingest_api._record_rederive(job, "running", [
                    {"voice_id": "v", "emotion": "happy"}])
                receipt = ingest_api._read_receipt("rd4")
            self.assertEqual(receipt["rederive"]["outcome"], "cancelled")
            self.assertEqual(len(receipt["rederive"]["voices"]), 1)

    def test_an_unknown_job_is_still_expired(self) -> None:
        with TemporaryDirectory() as td:
            with mock.patch.object(ingest_api, "WORK_ROOT", Path(td)):
                self.assertEqual(ingest_api.get_job("nope").status_code, 404)
                # ...and a receipt id cannot be talked into reaching a path.
                self.assertIsNone(ingest_api._read_receipt("../secrets"))

    def test_receipts_age_out(self) -> None:
        import os
        with TemporaryDirectory() as td:
            root = Path(td)
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                job = _job(root, "rd5", "cancelled", mode="rederive")
                ingest_api._record_rederive(job, "cancelled", [])
                p = ingest_api._receipt_path("rd5")
                self.assertTrue(p.is_file())
                old = time.time() - ingest_api._RECEIPT_TTL_S - 60
                os.utime(p, (old, old))
                ingest_api._gc_once()
                self.assertFalse(p.exists())


class CommitJournalTests(_JobsIsolated):
    def test_a_commit_journals_what_it_registers_and_clears_it(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            job = _job(root, "c9", "committing")
            ingest_api.JOBS["c9"] = job
            wd = Path(job["work_dir"])
            seen: list[dict] = []

            def fake_commit(work_dir, character, emotions, cid, **kw):
                out = []
                for emo in emotions:
                    v = {"voice_id": f"v-{emo}", "emotion": emo, "seconds": 5}
                    out.append(v)
                    kw["on_voice"](v)
                    seen.append(json.loads(
                        (wd / ingest_api._JOURNAL_NAME).read_text("utf-8")))
                return out

            with mock.patch.object(ingest_api.ingest, "commit",
                                   side_effect=fake_commit):
                ingest_api._do_commit("c9", "Ada", ["happy", "sad"], None, "mine")

            self.assertEqual([len(d["registered"]) for d in seen], [1, 2])
            self.assertEqual(seen[0]["intended"], ["happy", "sad"])
            self.assertEqual(job["status"], "committed")
            self.assertFalse((wd / ingest_api._JOURNAL_NAME).exists(),
                             "a finished commit leaves nothing to reconcile")

    def test_a_rolled_back_commit_leaves_no_journal(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            job = _job(root, "c8", "committing")
            ingest_api.JOBS["c8"] = job

            def fake_commit(work_dir, character, emotions, cid, **kw):
                kw["on_voice"]({"voice_id": "v-happy", "emotion": "happy"})
                raise RuntimeError("export died")

            with mock.patch.object(ingest_api.ingest, "commit",
                                   side_effect=fake_commit), \
                 mock.patch.object(ingest_api.voices, "remove_voices",
                                   return_value=["v-happy"]):
                ingest_api._do_commit("c8", "Ada", ["happy"], None, "mine")

            self.assertEqual(job["status"], "error")
            self.assertFalse(
                (Path(job["work_dir"]) / ingest_api._JOURNAL_NAME).exists())


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
