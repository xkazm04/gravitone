"""Pure-logic tests for the ingest job lifecycle (Directions 1-3).

Runs under stdlib unittest (pytest not installed on this box). Every subprocess
call (ffmpeg / ffprobe / pocket_tts) is mocked — no audio, no network, no models.
"""
from __future__ import annotations

import json
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service import ingest_api


class ValidationTests(unittest.TestCase):
    def test_rejects_empty(self):
        self.assertIsNotNone(ingest_api.validate_upload_bytes(b"", "a.mp3"))

    def test_rejects_oversize(self):
        big = b"\x00" * (ingest_api.MAX_UPLOAD_BYTES + 1)
        msg = ingest_api.validate_upload_bytes(big, "a.wav")
        self.assertIn("too large", msg or "")

    def test_rejects_non_audio(self):
        # No audio extension, no audio magic bytes.
        msg = ingest_api.validate_upload_bytes(b"just some text", "notes.txt")
        self.assertIn("unsupported", msg or "")

    def test_accepts_by_extension(self):
        self.assertIsNone(ingest_api.validate_upload_bytes(b"\x00\x01\x02\x03" * 4, "clip.mp3"))

    def test_accepts_by_magic_without_extension(self):
        wav = b"RIFF____WAVEfmt " + b"\x00" * 8
        self.assertIsNone(ingest_api.validate_upload_bytes(wav, "blob"))

    def test_accepts_mp3_frame_sync(self):
        self.assertIsNone(ingest_api.validate_upload_bytes(b"\xff\xfb\x90\x00" * 4, "blob"))

    def test_probe_duration_parses_ffprobe(self):
        fake = mock.Mock(returncode=0, stdout=b"7.53\n")
        with mock.patch("service.ingest_api.subprocess.run", return_value=fake):
            self.assertAlmostEqual(ingest_api.probe_duration(Path("x")), 7.53)

    def test_probe_duration_none_on_failure(self):
        fake = mock.Mock(returncode=1, stdout=b"")
        with mock.patch("service.ingest_api.subprocess.run", return_value=fake):
            self.assertIsNone(ingest_api.probe_duration(Path("x")))


def _make_job(root: Path, jid: str, status: str, created: float) -> dict:
    wd = root / jid
    wd.mkdir(parents=True, exist_ok=True)
    return {
        "id": jid, "status": status, "step": None, "mode": "sovereign",
        "steps": [], "partial": {}, "speakers": None, "duration": 0,
        "result": None, "error": None, "work_dir": str(wd), "created": created,
        "clip_sha256": "abc", "cancel": False, "committed": None,
    }


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self._patchers = []
        self._orig_jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()

    def tearDown(self):
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._orig_jobs)

    def test_persist_writes_state_json(self):
        with TemporaryDirectory() as td:
            job = _make_job(Path(td), "j1", "running", time.time())
            ingest_api._persist(job)
            state = json.loads((Path(td) / "j1" / "state.json").read_text("utf-8"))
            self.assertEqual(state["id"], "j1")
            self.assertEqual(state["status"], "running")

    def test_update_persists_and_respects_cancel(self):
        with TemporaryDirectory() as td:
            job = _make_job(Path(td), "j2", "running", time.time())
            ingest_api._update(job, status="done")
            self.assertEqual(job["status"], "done")
            # once cancelled, further updates are ignored (no resurrection)
            job["cancel"] = True
            ingest_api._update(job, status="error", error="boom")
            self.assertEqual(job["status"], "done")

    def test_rehydrate_marks_running_as_interrupted(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            running = _make_job(root, "run1", "running", time.time())
            ingest_api._persist(running)
            awaiting = _make_job(root, "wait1", "awaiting_speaker", time.time())
            ingest_api._persist(awaiting)
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                ingest_api._rehydrate()
            self.assertEqual(ingest_api.JOBS["run1"]["status"], "error")
            self.assertEqual(ingest_api.JOBS["run1"]["error"], "interrupted by restart")
            self.assertEqual(ingest_api.JOBS["wait1"]["status"], "awaiting_speaker")


class GcTests(unittest.TestCase):
    def setUp(self):
        self._orig_jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()

    def tearDown(self):
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._orig_jobs)

    def test_gc_expires_old_jobs_and_removes_workdir(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            old = _make_job(root, "old", "done", time.time() - ingest_api._TTL - 10)
            fresh = _make_job(root, "fresh", "done", time.time())
            ingest_api.JOBS["old"] = old
            ingest_api.JOBS["fresh"] = fresh
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                ingest_api._gc_once()
            self.assertNotIn("old", ingest_api.JOBS)
            self.assertFalse((root / "old").exists())
            self.assertIn("fresh", ingest_api.JOBS)
            self.assertTrue((root / "fresh").exists())

    def test_gc_expires_errored_jobs_too(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            err = _make_job(root, "e", "error", time.time() - ingest_api._TTL - 5)
            ingest_api.JOBS["e"] = err
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                ingest_api._gc_once()
            self.assertNotIn("e", ingest_api.JOBS)


class CommitLifecycleTests(unittest.TestCase):
    def setUp(self):
        self._orig_jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()

    def tearDown(self):
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._orig_jobs)

    def test_do_commit_streams_progress_and_marks_committed(self):
        with TemporaryDirectory() as td:
            job = _make_job(Path(td), "c1", "committing", time.time())
            job["partial"] = {"emotions_done": 0, "emotions_total": 2, "current": None}
            ingest_api.JOBS["c1"] = job

            def fake_commit(work_dir, character, emotions, cid, *, progress=None, should_cancel=None):
                out = []
                for idx, emo in enumerate(emotions):
                    if should_cancel and should_cancel():
                        break
                    if progress:
                        progress(idx, emo)
                    out.append({"voice_id": f"v-{emo}", "emotion": emo, "seconds": 5})
                    if progress:
                        progress(idx + 1, None)
                return out

            with mock.patch.object(ingest_api.ingest, "commit", side_effect=fake_commit):
                ingest_api._do_commit("c1", "Ada", ["happy", "sad"], None)

            self.assertEqual(job["status"], "committed")
            self.assertEqual(len(job["committed"]), 2)
            self.assertEqual(job["partial"]["emotions_done"], 2)
            self.assertEqual(job["partial"]["current"], None)

    def test_do_commit_stops_on_cancel(self):
        with TemporaryDirectory() as td:
            job = _make_job(Path(td), "c2", "committing", time.time())
            ingest_api.JOBS["c2"] = job

            def fake_commit(work_dir, character, emotions, cid, *, progress=None, should_cancel=None):
                out = []
                for idx, emo in enumerate(emotions):
                    if should_cancel and should_cancel():
                        break
                    job["cancel"] = True  # cancel arrives during the first emotion
                    out.append({"voice_id": f"v-{emo}", "emotion": emo, "seconds": 5})
                return out

            with mock.patch.object(ingest_api.ingest, "commit", side_effect=fake_commit):
                ingest_api._do_commit("c2", "Ada", ["happy", "sad"], None)

            # cancel flag set → _do_commit must not overwrite status to 'committed'
            self.assertNotEqual(job["status"], "committed")

    def test_cancel_job_cleans_workdir_and_removes(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            job = _make_job(root, "k1", "committing", time.time())
            (Path(job["work_dir"]) / "stem_happy.wav").write_bytes(b"x")
            ingest_api.JOBS["k1"] = job
            resp = ingest_api.cancel_job("k1")
            self.assertEqual(resp, {"status": "cancelled"})
            self.assertNotIn("k1", ingest_api.JOBS)
            self.assertFalse((root / "k1").exists())

    def test_cancel_unknown_returns_expired(self):
        resp = ingest_api.cancel_job("nope")
        self.assertEqual(resp.status_code, 404)


if __name__ == "__main__":
    unittest.main()
