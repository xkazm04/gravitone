"""Pure-logic tests for the ingest job lifecycle (Directions 1-3).

Runs under stdlib unittest (pytest not installed on this box). Every subprocess
call (ffmpeg / ffprobe / pocket_tts) is mocked — no audio, no network, no models.
"""
from __future__ import annotations

import io
import json
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service import ingest_api


class _FakeExportPopen:
    """Stand-in for the one-load `service.export_stems` child. Reads the spec
    the parent wrote, 'exports' each stem (writes its dst file), and streams one
    JSON status line per stem on stdout — exactly the real protocol. Counts how
    many times it was spawned so a test can prove ONE load serves N stems."""

    spawned = 0

    def __init__(self, cmd, stdout=None, stderr=None, text=None):
        type(self).spawned += 1
        self.terminated = False
        spec = json.loads(Path(cmd[-1]).read_text("utf-8"))
        self._stems = spec["stems"]
        self.stdout = self._gen()
        self.stderr = io.StringIO("")
        self.returncode = 0

    def _gen(self):
        for stem in self._stems:
            Path(stem["dst"]).write_bytes(b"tensors")  # emulate the export
            yield json.dumps({"emotion": stem["emotion"], "ok": True}) + "\n"

    def wait(self, timeout=None):
        return 0

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.terminated = True


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

            def fake_commit(work_dir, character, emotions, cid, *, consent=None,
                            clip_sha256=None, progress=None, should_cancel=None):
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
                ingest_api._do_commit("c1", "Ada", ["happy", "sad"], None, "I consent.")

            self.assertEqual(job["status"], "committed")
            self.assertEqual(len(job["committed"]), 2)
            self.assertEqual(job["partial"]["emotions_done"], 2)
            self.assertEqual(job["partial"]["current"], None)

    def test_do_commit_stops_on_cancel(self):
        with TemporaryDirectory() as td:
            job = _make_job(Path(td), "c2", "committing", time.time())
            ingest_api.JOBS["c2"] = job

            def fake_commit(work_dir, character, emotions, cid, *, consent=None,
                            clip_sha256=None, progress=None, should_cancel=None):
                out = []
                for idx, emo in enumerate(emotions):
                    if should_cancel and should_cancel():
                        break
                    job["cancel"] = True  # cancel arrives during the first emotion
                    out.append({"voice_id": f"v-{emo}", "emotion": emo, "seconds": 5})
                return out

            with mock.patch.object(ingest_api.ingest, "commit", side_effect=fake_commit):
                ingest_api._do_commit("c2", "Ada", ["happy", "sad"], None, "I consent.")

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


class ConsentTests(unittest.TestCase):
    def setUp(self):
        self._orig_jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()

    def tearDown(self):
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._orig_jobs)

    def test_commit_requires_attestation(self):
        from fastapi import HTTPException
        with TemporaryDirectory() as td:
            job = _make_job(Path(td), "a", "done", time.time())
            ingest_api.JOBS["a"] = job
            req = ingest_api.CommitReq(character="Ada", emotions=["happy"], attested=False)
            with self.assertRaises(HTTPException) as ctx:
                ingest_api.commit("a", req)
            self.assertEqual(ctx.exception.status_code, 422)

    def test_commit_requires_nonempty_statement(self):
        from fastapi import HTTPException
        with TemporaryDirectory() as td:
            job = _make_job(Path(td), "b", "done", time.time())
            ingest_api.JOBS["b"] = job
            req = ingest_api.CommitReq(character="Ada", emotions=["happy"],
                                       attested=True, statement="   ")
            with self.assertRaises(HTTPException) as ctx:
                ingest_api.commit("b", req)
            self.assertEqual(ctx.exception.status_code, 422)

    def test_consent_receipt_written_into_meta(self):
        from service import ingest as ing
        from service import voices as vc
        with TemporaryDirectory() as td:
            root = Path(td)
            wd = root / "work"
            wd.mkdir()
            (wd / "stem_happy.wav").write_bytes(b"fake")

            _FakeExportPopen.spawned = 0
            # 6s stem — comfortably over the 4s eligibility floor.
            fake_wave = mock.MagicMock()
            fake_wave.__enter__.return_value.getnframes.return_value = 24000 * 6
            fake_wave.__enter__.return_value.getframerate.return_value = 24000

            with mock.patch.object(ing, "VOICES_DIR", root), \
                 mock.patch.object(vc, "VOICES_DIR", root), \
                 mock.patch.object(vc, "META_PATH", root / "_meta.json"), \
                 mock.patch.object(ing.subprocess, "Popen", _FakeExportPopen), \
                 mock.patch.object(ing.wave, "open", return_value=fake_wave):
                created = ing.commit(wd, "Ada", ["happy"], None,
                                     consent="I own this voice.", clip_sha256="deadbeef")
                self.assertEqual(len(created), 1)
                self.assertEqual(_FakeExportPopen.spawned, 1)  # one model load
                meta = json.loads((root / "_meta.json").read_text("utf-8"))
            entry = next(iter(meta["voices"].values()))
            self.assertEqual(entry["consent"]["statement"], "I own this voice.")
            self.assertEqual(entry["consent"]["clip_sha256"], "deadbeef")
            self.assertIn("consented_at", entry["consent"])

    def test_voice_consent_flag_from_meta(self):
        from service import voices as vc
        with TemporaryDirectory() as td:
            root = Path(td)
            (root / "consented.safetensors").write_bytes(b"x")
            (root / "legacy.safetensors").write_bytes(b"x")
            meta = {"voices": {
                "consented": {"name": "Ada", "character_id": "ada", "emotion": "happy",
                              "consent": {"statement": "ok", "clip_sha256": "h",
                                          "consented_at": "2026-01-01T00:00:00+00:00"}},
                "legacy": {"name": "Old", "character_id": "old", "emotion": "baseline"},
            }, "characters": {"ada": {"name": "Ada"}, "old": {"name": "Old"}}}
            with mock.patch.object(vc, "VOICES_DIR", root):
                voices = vc._cloned_voices(meta)
            by_id = {v.voice_id: v for v in voices}
            self.assertTrue(by_id["consented"].consent)
            self.assertFalse(by_id["legacy"].consent)


if __name__ == "__main__":
    unittest.main()
