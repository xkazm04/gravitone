"""The re-voice JOB layer — the admission door and the reclamation of a
job's work dir.

`test_revoice.py` covers the pure fit ladder; this file covers the lifecycle
around it. What it pins: admission is a HELD permit that comes back on every
exit path (including a worker killed by a BaseException, which reaches no
`except` clause), the 429 refusal costs nothing, and no door deletes a work dir
that a `FileResponse` may still be streaming out of.
"""
from __future__ import annotations

import json
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service import revoice_api


class _Mind:
    def describe(self):
        return {"backend": "test"}

    def complete_json(self, prompt):
        return {"lines": [{"i": 0, "emotion": "baseline"},
                          {"i": 1, "emotion": "baseline"}]}

    def complete(self, prompt, **kw):
        return "shorter"


class AdmissionTests(unittest.TestCase):
    """The door is a HELD permit. A worker that dies without reaching an
    `except` must not leave MAX_ACTIVE shut for the whole running-TTL."""

    def setUp(self) -> None:
        self._admit = mock.patch.object(revoice_api, "_ADMIT",
                                        threading.BoundedSemaphore(1))
        self._admit.start()
        self.addCleanup(self._admit.stop)

    def _job(self, td: str) -> dict:
        wd = Path(td) / "job"
        wd.mkdir(exist_ok=True)
        return {"id": "a1", "status": "running", "step": "fetch",
                "steps": [{"key": k, "label": l, "state": "pending"}
                          for k, l in revoice_api.STEPS],
                "partial": {}, "error": None,
                "source": {"kind": "url", "url": "https://x/v", "title": "c"},
                "lines": [{"i": 0, "character_id": "ada", "text": "hi",
                           "start": 0.0, "end": 4.0, "emotion": "baseline"}],
                "options": {"direct": False, "rewrite": False},
                "brain": None, "result": None, "limits": [],
                "work_dir": str(wd), "cancel": False, "permit": True,
                "created": 0.0, "touched": 0.0}

    def test_a_worker_killed_by_a_base_exception_frees_the_door(self) -> None:
        self.assertTrue(revoice_api._acquire_admission())
        with TemporaryDirectory() as td:
            job = self._job(td)
            with mock.patch.object(revoice_api.ingest_url, "download_video",
                                   side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    revoice_api._run_job(job)
            # the job is still wedged at "running" — that is exactly why the
            # door may not be derived from job status
            self.assertEqual(job["status"], "running")
        self.assertTrue(revoice_api._acquire_admission(),
                        "the permit was not returned by the finally")

    def test_the_permit_comes_back_exactly_once(self) -> None:
        self.assertTrue(revoice_api._acquire_admission())
        with TemporaryDirectory() as td:
            job = self._job(td)
            revoice_api._release_admission(job)
            revoice_api._release_admission(job)  # must be a no-op, not a boom
        self.assertTrue(revoice_api._acquire_admission())
        self.assertFalse(revoice_api._acquire_admission())


class DoorTests(unittest.TestCase):
    """POST /v1/revoice — the 429 refusal and what it costs."""

    def setUp(self) -> None:
        self._admit = mock.patch.object(revoice_api, "_ADMIT",
                                        threading.BoundedSemaphore(1))
        self._admit.start()
        self.addCleanup(self._admit.stop)
        self._td = TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        wd = mock.patch.object(revoice_api, "WORK_DIR", Path(self._td.name))
        wd.start()
        self.addCleanup(wd.stop)
        started: list[dict] = []
        self.started = started

        class _Thread:
            def __init__(self, target=None, args=(), **kw):
                self.args = args

            def start(self):
                started.append(self.args[0])

        for p in (
            mock.patch.object(revoice_api, "emotion_map",
                              return_value={"baseline": "v1"}),
            mock.patch.object(revoice_api.brain_mod, "make_brain",
                              return_value=_Mind()),
            mock.patch.object(revoice_api.ingest_url, "guard_link",
                              side_effect=lambda u: u),
            mock.patch.object(revoice_api.ingest_url, "probe",
                              return_value=type("I", (), {"duration": 20.0,
                                                          "title": "clip"})()),
            mock.patch.object(revoice_api.threading, "Thread", _Thread),
        ):
            p.start()
            self.addCleanup(p.stop)

    def _req(self) -> revoice_api.RevoiceReq:
        return revoice_api.RevoiceReq(
            url="https://x/v",
            lines=[{"character_id": "ada", "text": "hi",
                    "start": 0.0, "end": 4.0}],
            direct=False, rewrite=False)

    def tearDown(self) -> None:
        for job in self.started:
            with revoice_api._LOCK:
                revoice_api.JOBS.pop(job["id"], None)

    def test_a_second_video_is_refused_with_429_and_retry_after(self) -> None:
        first = revoice_api.start(self._req())
        self.assertIn("job_id", first)
        second = revoice_api.start(self._req())
        self.assertEqual(second.status_code, 429)
        self.assertEqual(second.headers["retry-after"], "60")
        self.assertIn("already re-voicing",
                      json.loads(bytes(second.body))["detail"])

    def test_the_refused_call_leaves_no_job_behind(self) -> None:
        revoice_api.start(self._req())
        before = len(revoice_api.JOBS)
        revoice_api.start(self._req())
        self.assertEqual(len(revoice_api.JOBS), before)

    def test_finishing_a_job_reopens_the_door(self) -> None:
        revoice_api.start(self._req())
        self.assertEqual(revoice_api.start(self._req()).status_code, 429)
        revoice_api._release_admission(self.started[0])
        self.assertIn("job_id", revoice_api.start(self._req()))


class ReapTests(unittest.TestCase):
    """Cancelling a finished job must not pull the mp4 out from under a
    download that is already streaming: deletion is deferred to `_gc`."""

    def setUp(self) -> None:
        self._reap = mock.patch.object(revoice_api, "_REAP", [])
        self._reap.start()
        self.addCleanup(self._reap.stop)

    def test_cancel_on_a_terminal_job_defers_the_delete(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td) / "job"
            wd.mkdir()
            (wd / "revoiced.mp4").write_bytes(b"mp4")
            job = {"id": "r1", "status": "done", "work_dir": str(wd),
                   "cancel": False, "created": time.time(),
                   "touched": time.time()}
            with revoice_api._LOCK:
                revoice_api.JOBS[job["id"]] = job
            try:
                revoice_api.cancel("r1")
                self.assertNotIn("r1", revoice_api.JOBS)
                self.assertTrue((wd / "revoiced.mp4").is_file(),
                                "the artifact was deleted under a live reader")
                self.assertEqual(len(revoice_api._REAP), 1)
                # once the grace has passed, _gc takes it
                revoice_api._REAP[:] = [(0.0, str(wd))]
                revoice_api._gc()
                self.assertFalse(wd.exists())
            finally:
                with revoice_api._LOCK:
                    revoice_api.JOBS.pop("r1", None)

    def test_cancel_on_a_running_job_never_touches_its_work_dir(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td) / "job"
            wd.mkdir()
            (wd / "track.wav").write_bytes(b"wav")
            job = {"id": "r2", "status": "running", "work_dir": str(wd),
                   "cancel": False, "created": time.time(),
                   "touched": time.time()}
            with revoice_api._LOCK:
                revoice_api.JOBS[job["id"]] = job
            try:
                revoice_api.cancel("r2")
                self.assertEqual(job["status"], "cancelled")
                self.assertTrue(job["cancel"])
                self.assertTrue((wd / "track.wav").is_file())
                self.assertEqual(revoice_api._REAP, [])
            finally:
                with revoice_api._LOCK:
                    revoice_api.JOBS.pop("r2", None)


if __name__ == "__main__":
    unittest.main()
