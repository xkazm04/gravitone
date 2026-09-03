"""Abandonment discipline for ingest: cancel stops the work, a FAILED commit
rolls back, and concurrency is bounded.

Before this, cancel was honoured by `commit` alone — pressing it during a scan
left ~40 paid classifier calls and ~40 ffmpeg extracts running against a
workdir that had already been deleted — and the commit ERROR path did no
rollback at all, leaving exactly the partial Character the cancel path exists to
prevent.

Everything external is mocked: no ffmpeg, no network, no torch.
"""
from __future__ import annotations

import io
import json
import threading
import time
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi import HTTPException

from service import ingest, ingest_api
from service import voices as vc


def _write_wav(path: Path, frames: int = 24000) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x00\x00" * frames)


def _seg(i: int) -> dict:
    return {"speaker": "speaker_0", "start": float(i), "end": float(i) + 1.0,
            "text": f"line {i}"}


class LabelCancelTests(unittest.TestCase):
    """The biggest fan-out in the pipeline must stop when the job is gone."""

    def _work(self, td: str, n: int) -> Path:
        wd = Path(td)
        _write_wav(wd / "clean.wav")
        (wd / "segments.json").write_text(json.dumps([_seg(i) for i in range(n)]), "utf-8")
        return wd

    def test_cancel_during_label_stops_the_remaining_segments(self) -> None:
        n = 24
        calls: list[int] = []
        lock = threading.Lock()
        flag = {"cancel": False}

        def fake_label(wav_paths, spend=None):
            with lock:
                calls.extend(wav_paths)
                flag["cancel"] = True          # the DELETE lands on batch one
            return [{"emotion": "happy", "confidence": 0.9, "cue": "c",
                     "model": "flash"} for _ in wav_paths]

        with TemporaryDirectory() as td:
            wd = self._work(td, n)
            with mock.patch.object(ingest, "to_wav",
                                   side_effect=lambda src, dst, a=None, b=None: _write_wav(Path(dst), 240)), \
                 mock.patch.object(ingest, "label_emotions", side_effect=fake_label):
                with self.assertRaises(ingest.Cancelled):
                    ingest.label_and_stem(wd, "speaker_0", mode="cloud",
                                          should_cancel=lambda: flag["cancel"])
            # Only the batches already in flight were paid for; the queued ones
            # drained without a call. (Bounded by the pool, hence the margin.)
            self.assertLess(len(calls), n)
            self.assertLessEqual(len(calls), ingest.LABEL_WORKERS * ingest.LABEL_BATCH)
            # Nothing was spliced into the (already torn-down) workdir.
            self.assertEqual(list(wd.glob("stem_*.wav")), [])

    def test_cancel_before_the_batch_pays_for_nothing(self) -> None:
        with TemporaryDirectory() as td:
            wd = self._work(td, 8)
            with mock.patch.object(ingest, "to_wav") as to_wav, \
                 mock.patch.object(ingest, "label_emotions") as lab:
                with self.assertRaises(ingest.Cancelled):
                    ingest.label_and_stem(wd, "speaker_0", mode="cloud",
                                          should_cancel=lambda: True)
            to_wav.assert_not_called()
            lab.assert_not_called()

    def test_analyze_cancelled_mid_flight_abandons_both_paid_calls(self) -> None:
        """The overlapped shape, stated honestly.

        Scribe and the Isolator now start TOGETHER (they are independent calls
        on the same file and were the two longest waits in a scan), so a cancel
        that arrives once scribe is running can no longer PREVENT the second
        call — it is already out. What it does is abandon both: `Cancelled`
        propagates, nothing is written, and the ledger still shows what the
        cancel could not un-bill. `test_analyze_cancelled_up_front_...` below
        pins the case where a cancel does still save the money.
        """
        with TemporaryDirectory() as td:
            wd = Path(td)
            flag = {"cancel": False}
            ledger = ingest.Spend()

            def fake_scribe(path, spend=None):
                (spend or ledger).charge(ingest.ELEVEN)
                flag["cancel"] = True
                return {"words": [], "audio_duration_secs": 5, "text": "hi"}

            def fake_isolate(path, dst, spend=None):
                (spend or ledger).charge(ingest.ELEVEN)

            with mock.patch.object(ingest, "ELEVEN_KEY", "k"), \
                 mock.patch.object(ingest, "GEMINI_KEY", "k"), \
                 mock.patch.object(ingest, "scribe", side_effect=fake_scribe), \
                 mock.patch.object(ingest, "clean_audio"), \
                 mock.patch.object(ingest, "voice_isolate",
                                   side_effect=fake_isolate) as iso:
                with self.assertRaises(ingest.Cancelled):
                    ingest.analyze(wd / "in.wav", wd, spend=ledger,
                                   should_cancel=lambda: flag["cancel"])
            iso.assert_called_once()          # in flight, not preventable
            # Abandoned, not free: what was spent is still on the ledger.
            self.assertEqual(ledger.snapshot()["calls"][ingest.ELEVEN], 2)

    def test_analyze_cancelled_up_front_pays_for_nothing(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td)
            with mock.patch.object(ingest, "ELEVEN_KEY", "k"), \
                 mock.patch.object(ingest, "GEMINI_KEY", "k"), \
                 mock.patch.object(ingest, "scribe") as scr, \
                 mock.patch.object(ingest, "voice_isolate") as iso:
                with self.assertRaises(ingest.Cancelled):
                    ingest.analyze(wd / "in.wav", wd, should_cancel=lambda: True)
            scr.assert_not_called()
            iso.assert_not_called()


class _FailingExportPopen:
    """The one-load export child, failing on its SECOND stem — the shape that
    used to leave the first emotion registered forever."""

    def __init__(self, cmd, stdout=None, stderr=None, text=None):
        spec = json.loads(Path(cmd[-1]).read_text("utf-8"))
        self._stems = spec["stems"]
        self.stdout = self._gen()
        self.stderr = io.StringIO(
            "Traceback (most recent call last):\n  File \"/srv/secret/path.py\"\n"
            "RuntimeError: CUDA_SECRET_TOKEN=abc123 blew up\n")
        self.returncode = 1

    def _gen(self):
        for idx, stem in enumerate(self._stems):
            if idx == 0:
                Path(stem["dst"]).write_bytes(b"tensors")
                yield json.dumps({"emotion": stem["emotion"], "ok": True}) + "\n"
            else:
                yield json.dumps({"emotion": stem["emotion"], "ok": False,
                                  "error": "/srv/secret/path.py exploded"}) + "\n"

    def wait(self, timeout=None):
        return 1

    def terminate(self):
        pass

    def kill(self):
        pass


class FailedCommitRollbackTests(unittest.TestCase):
    """A commit that RAISES mid-batch must leave no registered Voices — the
    same guarantee a cancelled commit has had."""

    def setUp(self) -> None:
        self._orig_jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()
        self._td = TemporaryDirectory()
        self.root = Path(self._td.name)
        self.store = self.root / "voices"
        self.store.mkdir()
        self._patches = [
            mock.patch.object(ingest, "VOICES_DIR", self.store),
            mock.patch.object(vc, "VOICES_DIR", self.store),
            mock.patch.object(vc, "META_PATH", self.store / "_meta.json"),
            mock.patch.object(vc, "_META_LOCK_PATH", self.store / "._meta.lock"),
        ]
        for p in self._patches:
            p.start()
        vc.invalidate()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        vc.invalidate()
        self._td.cleanup()
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._orig_jobs)

    def _job(self) -> dict:
        wd = self.root / "work"
        wd.mkdir(exist_ok=True)
        for emo in ("happy", "sad"):
            _write_wav(wd / f"stem_{emo}.wav", 24000 * 6)   # 6s — over the floor
        job = {"id": "f1", "status": "committing", "step": None, "mode": "cloud",
               "steps": [], "partial": {}, "speakers": None, "duration": 0,
               "result": None, "error": None, "work_dir": str(wd),
               "created": time.time(), "clip_sha256": "abc", "cancel": False,
               "committed": None}
        ingest_api.JOBS["f1"] = job
        return job

    def _meta(self) -> dict:
        p = self.store / "_meta.json"
        return json.loads(p.read_text("utf-8")) if p.is_file() else {"voices": {}}

    def test_failed_commit_registers_nothing(self) -> None:
        job = self._job()
        with mock.patch.object(ingest.subprocess, "Popen", _FailingExportPopen):
            ingest_api._do_commit("f1", "Ada", ["happy", "sad"], None, "I consent.")

        self.assertEqual(job["status"], "error")
        # The first emotion WAS cloned and registered before the failure; the
        # rollback took it back out, so no partial Character survives.
        self.assertEqual(self._meta()["voices"], {})
        self.assertEqual(self._meta().get("characters", {}), {})
        self.assertEqual(list(self.store.glob("*.safetensors")), [])

    def test_failure_detail_is_sanitized_not_raw_stderr(self) -> None:
        job = self._job()
        with mock.patch.object(ingest.subprocess, "Popen", _FailingExportPopen):
            ingest_api._do_commit("f1", "Ada", ["happy", "sad"], None, "I consent.")

        detail = job["error"]
        self.assertIn("voice cloning failed (request ", detail)
        for leak in ("/srv/secret/path.py", "CUDA_SECRET_TOKEN", "Traceback"):
            self.assertNotIn(leak, detail)

    def test_rollback_failure_on_the_error_path_is_logged_loudly(self) -> None:
        self._job()
        with mock.patch.object(ingest.subprocess, "Popen", _FailingExportPopen), \
             mock.patch.object(ingest_api.voices, "remove_voices",
                               side_effect=OSError("disk gone")), \
             self.assertLogs("gravitone", level="ERROR") as logs:
            ingest_api._do_commit("f1", "Ada", ["happy", "sad"], None, "I consent.")
        self.assertIn("ROLLBACK FAILED", "\n".join(logs.output))


class AdmissionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_jobs = dict(ingest_api.JOBS)
        ingest_api.JOBS.clear()

    def tearDown(self) -> None:
        ingest_api.JOBS.clear()
        ingest_api.JOBS.update(self._orig_jobs)

    def _running(self, jid: str) -> None:
        ingest_api.JOBS[jid] = {"id": jid, "status": "running", "work_dir": jid,
                                "created": time.time(), "cancel": False}

    def test_admits_below_the_limit(self) -> None:
        with mock.patch.object(ingest_api, "MAX_ACTIVE_JOBS", 2):
            self._running("a")
            ingest_api._admit()          # must not raise

    def test_rejects_with_429_at_the_limit(self) -> None:
        with mock.patch.object(ingest_api, "MAX_ACTIVE_JOBS", 1):
            self._running("a")
            with self.assertRaises(HTTPException) as ctx:
                ingest_api._admit()
            self.assertEqual(ctx.exception.status_code, 429)

    def test_idle_jobs_do_not_consume_the_budget(self) -> None:
        with mock.patch.object(ingest_api, "MAX_ACTIVE_JOBS", 1):
            for jid, status in (("d", "done"), ("w", "awaiting_speaker"),
                                ("e", "error"), ("c", "committed")):
                ingest_api.JOBS[jid] = {"id": jid, "status": status,
                                        "work_dir": jid, "created": time.time()}
            ingest_api._admit()          # must not raise

    def test_speaker_route_is_gated(self) -> None:
        with mock.patch.object(ingest_api, "MAX_ACTIVE_JOBS", 1):
            self._running("a")
            with self.assertRaises(HTTPException) as ctx:
                ingest_api.choose_speaker("a", ingest_api.SpeakerReq(speaker_id="s"))
            self.assertEqual(ctx.exception.status_code, 429)


if __name__ == "__main__":
    unittest.main()
