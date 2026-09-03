"""Pure-logic tests for the ingest job lifecycle (Directions 1-3).

Runs under stdlib unittest (pytest not installed on this box). Every subprocess
call (ffmpeg / ffprobe / pocket_tts) is mocked — no audio, no network, no models.
"""
from __future__ import annotations

import io
import json
import shutil
import threading
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

    def test_probe_duration_none_when_ffprobe_is_missing(self):
        with mock.patch("service.ingest_api.subprocess.run",
                        side_effect=FileNotFoundError("ffprobe")):
            self.assertIsNone(ingest_api.probe_duration(Path("x")))

    def test_duration_gate_accepts_a_normal_clip(self):
        self.assertIsNone(ingest_api.check_duration(30.0))

    def test_duration_gate_rejects_short(self):
        msg = ingest_api.check_duration(1.0) or ""
        self.assertIn("too short", msg)

    def test_duration_gate_rejects_long_before_anything_is_paid_for(self):
        # There was a floor and no ceiling; both ElevenLabs calls bill by length.
        msg = ingest_api.check_duration(ingest_api.MAX_CLIP_SECONDS + 1) or ""
        self.assertIn("too long", msg)

    def test_duration_gate_fails_closed_when_unknown(self):
        # `dur is None` used to disable the gate entirely and wave the upload
        # straight through to the transcriber.
        self.assertIsNotNone(ingest_api.check_duration(None))


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

    def test_gc_sets_cancel_before_teardown(self):
        # A phase thread still holding a reference to the reaped job must see
        # cancel=True — otherwise it keeps working against a deleted workdir.
        # (cancel_job has always done this; GC used to skip the protocol.)
        with TemporaryDirectory() as td:
            root = Path(td)
            old = _make_job(root, "old", "done",
                            time.time() - ingest_api._TTL - 10)
            ingest_api.JOBS["old"] = old
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                ingest_api._gc_once()
            self.assertTrue(old["cancel"], "GC must flag the job it tears down")

    def test_gc_leaves_a_running_job_alone(self):
        # The bug: expiry looked only at age, so a long cloud scan that outran
        # the idle TTL had its workdir deleted from under the running thread.
        with TemporaryDirectory() as td:
            root = Path(td)
            for status in ingest_api.ACTIVE_STATUSES:
                job = _make_job(root, status, status,
                                time.time() - ingest_api._TTL - 60)
                job["touched"] = time.time()      # still reporting progress
                ingest_api.JOBS[status] = job
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                ingest_api._gc_once()
            for status in ingest_api.ACTIVE_STATUSES:
                self.assertIn(status, ingest_api.JOBS)
                self.assertTrue((root / status).is_dir())
                self.assertFalse(ingest_api.JOBS[status]["cancel"])

    def test_gc_still_reaps_a_wedged_running_job(self):
        # Status-aware expiry must not become "never expires": a job that has
        # made no progress for the wedged threshold is still torn down.
        with TemporaryDirectory() as td:
            root = Path(td)
            job = _make_job(root, "wedged", "running",
                            time.time() - ingest_api._RUNNING_TTL - 60)
            job["touched"] = job["created"]
            ingest_api.JOBS["wedged"] = job
            with mock.patch.object(ingest_api, "WORK_ROOT", root):
                ingest_api._gc_once()
            self.assertNotIn("wedged", ingest_api.JOBS)
            self.assertTrue(job["cancel"])

    def test_idle_job_ages_from_last_activity_not_creation(self):
        # `touched` is the heartbeat every state mutation writes.
        with TemporaryDirectory() as td:
            old_created = time.time() - ingest_api._TTL - 60
            job = _make_job(Path(td), "x", "awaiting_speaker", old_created)
            job["touched"] = time.time()
            self.assertFalse(ingest_api._is_expired(job, time.time()))
            job["touched"] = old_created
            self.assertTrue(ingest_api._is_expired(job, time.time()))

    def test_persist_does_not_resurrect_a_reaped_workdir(self):
        # _persist used to mkdir(parents=True), recreating a directory GC or
        # DELETE had just removed — an orphan tree owned by no job.
        with TemporaryDirectory() as td:
            root = Path(td)
            job = _make_job(root, "gone", "committing", time.time())
            wd = Path(job["work_dir"])
            self.assertTrue(wd.is_dir())
            shutil.rmtree(wd)
            ingest_api._persist(job)
            self.assertFalse(wd.exists(), "persist must not recreate the workdir")


class PhaseThreadTeardownTests(unittest.TestCase):
    """A DELETE landing between Thread.start() and the phase body's first line
    used to kill the thread with an uncaught KeyError."""

    def setUp(self):
        self._orig_jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()

    def tearDown(self):
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._orig_jobs)

    def test_phases_exit_quietly_when_job_is_gone(self):
        with TemporaryDirectory() as td:
            audio = Path(td) / "clip.wav"
            audio.write_bytes(b"RIFF")
            # JOBS is empty — every phase must return, not raise.
            ingest_api._analyze("nosuch", audio)
            ingest_api._label("nosuch", "spk1")
            ingest_api._do_commit("nosuch", "Char", ["happy"], None, "mine")
            self.assertFalse(audio.exists(), "_analyze cleans its upload up")

    def test_get_job_is_locked_and_returns_none_when_absent(self):
        self.assertIsNone(ingest_api._get_job("nope"))


class BackgroundStartTests(unittest.TestCase):
    def test_no_thread_starts_at_import(self):
        # Importing the module must not spawn the GC sweeper: it would race
        # tests that patch WORK_ROOT, and in production it ran before the app
        # was ready. The lifespan calls start_background() instead.
        names = [t.name for t in threading.enumerate()]
        self.assertNotIn("ingest-gc", names)

    def test_start_background_is_idempotent(self):
        with mock.patch.object(ingest_api, "_rehydrate") as rehy, \
             mock.patch.object(ingest_api.threading, "Thread") as thread:
            orig = ingest_api._started
            ingest_api._started = False
            try:
                ingest_api.start_background()
                ingest_api.start_background()
            finally:
                ingest_api._started = orig
            self.assertEqual(rehy.call_count, 1)
            self.assertEqual(thread.call_count, 1)


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
                            clip_sha256=None, progress=None, should_cancel=None,
                            on_voice=None):
                out = []
                for idx, emo in enumerate(emotions):
                    if should_cancel and should_cancel():
                        break
                    if progress:
                        progress(idx, emo)
                    v = {"voice_id": f"v-{emo}", "emotion": emo, "seconds": 5}
                    out.append(v)
                    if on_voice:
                        on_voice(v)
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
                            clip_sha256=None, progress=None, should_cancel=None,
                            on_voice=None):
                out = []
                for idx, emo in enumerate(emotions):
                    if should_cancel and should_cancel():
                        break
                    job["cancel"] = True  # cancel arrives during the first emotion
                    out.append({"voice_id": f"v-{emo}", "emotion": emo, "seconds": 5})
                return out

            # remove_voices is stubbed: this test is about the status, and the
            # real one would mutate the repo's voices registry.
            with mock.patch.object(ingest_api.ingest, "commit", side_effect=fake_commit), \
                 mock.patch.object(ingest_api.voices, "remove_voices", return_value=[]):
                ingest_api._do_commit("c2", "Ada", ["happy", "sad"], None, "I consent.")

            # cancel flag set → _do_commit must not overwrite status to 'committed'
            self.assertNotEqual(job["status"], "committed")

    def test_cancelled_commit_rolls_back_the_voices_it_created(self):
        # Cancelling only tore down the WORKDIR; the emotions already cloned
        # stayed registered, so "cancel" silently handed the user a partial
        # Character. They must be removed.
        with TemporaryDirectory() as td:
            job = _make_job(Path(td), "c3", "committing", time.time())
            ingest_api.JOBS["c3"] = job

            def fake_commit(work_dir, character, emotions, cid, *, consent=None,
                            clip_sha256=None, progress=None, should_cancel=None,
                            on_voice=None):
                job["cancel"] = True          # cancel lands mid-clone
                return [{"voice_id": "v-happy", "emotion": "happy", "seconds": 5}]

            with mock.patch.object(ingest_api.ingest, "commit", side_effect=fake_commit), \
                 mock.patch.object(ingest_api.voices, "remove_voices",
                                   return_value=["v-happy"]) as rm:
                ingest_api._do_commit("c3", "Ada", ["happy", "sad"], None, "I consent.")

            rm.assert_called_once_with(["v-happy"])
            self.assertNotEqual(job["status"], "committed")

    def test_successful_commit_rolls_back_nothing(self):
        with TemporaryDirectory() as td:
            job = _make_job(Path(td), "c4", "committing", time.time())
            ingest_api.JOBS["c4"] = job

            def fake_commit(work_dir, character, emotions, cid, **kw):
                return [{"voice_id": f"v-{e}", "emotion": e, "seconds": 5} for e in emotions]

            with mock.patch.object(ingest_api.ingest, "commit", side_effect=fake_commit), \
                 mock.patch.object(ingest_api.voices, "remove_voices") as rm:
                ingest_api._do_commit("c4", "Ada", ["happy"], None, "I consent.")

            rm.assert_not_called()
            self.assertEqual(job["status"], "committed")

    def test_rollback_failure_is_logged_loudly_not_swallowed(self):
        # If the rollback itself fails the voices ARE live and the user thinks
        # they cancelled — that must never be silent.
        with TemporaryDirectory() as td:
            job = _make_job(Path(td), "c5", "committing", time.time())
            ingest_api.JOBS["c5"] = job

            def fake_commit(work_dir, character, emotions, cid, **kw):
                job["cancel"] = True
                return [{"voice_id": "v-happy", "emotion": "happy", "seconds": 5}]

            with mock.patch.object(ingest_api.ingest, "commit", side_effect=fake_commit), \
                 mock.patch.object(ingest_api.voices, "remove_voices",
                                   side_effect=OSError("disk gone")), \
                 self.assertLogs("gravitone", level="ERROR") as logs:
                ingest_api._do_commit("c5", "Ada", ["happy"], None, "I consent.")

            joined = "\n".join(logs.output)
            self.assertIn("ROLLBACK FAILED", joined)
            self.assertIn("v-happy", joined)

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
