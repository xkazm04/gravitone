"""The re-voice JOB layer — `_run_job` end to end with every seam stubbed
(no network, no engine, no ffmpeg, no brain), plus the admission door.

`test_revoice.py` covers the pure fit ladder; this file covers the thing that
CALLS it. What it pins, mirroring test_voiceover.py's JobRunTests: step order,
exactly one terminal state, the artifacts on disk — and then the failure modes
that only exist up here: a mux that dies after a full (expensive) speak pass,
a run where every line refused, a cancel arriving mid-speak, and the admission
permit, which must come back even when the worker dies without an `except`.
"""
from __future__ import annotations

import io
import json
import threading
import time
import unittest
import wave
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import numpy as np

from service import revoice_api, voiceover


def _wav(seconds: float, rate: int = voiceover.RATE) -> bytes:
    pcm = (np.ones(int(seconds * rate)) * 0.25 * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class _Mind:
    def describe(self):
        return {"backend": "test"}

    def complete_json(self, prompt):
        return {"lines": [{"i": 0, "emotion": "baseline"},
                          {"i": 1, "emotion": "baseline"}]}

    def complete(self, prompt, **kw):
        return "shorter"


class JobRunTests(unittest.TestCase):
    """One whole `_run_job`, every seam stubbed."""

    LINES = [(0.0, 4.0), (5.0, 9.0)]

    def _job(self, td: str, *, lines=None, options=None) -> dict:
        wd = Path(td) / "job"
        wd.mkdir(exist_ok=True)
        bounds = lines if lines is not None else self.LINES
        return {"id": "t1", "status": "running", "step": "fetch",
                "steps": [{"key": k, "label": l, "state": "pending"}
                          for k, l in revoice_api.STEPS],
                "partial": {}, "error": None,
                "source": {"kind": "url", "url": "https://x/v", "title": "clip"},
                "lines": [{"i": i, "character_id": "ada", "text": f"line {i}",
                           "start": a, "end": b, "emotion": "baseline"}
                          for i, (a, b) in enumerate(bounds)],
                "options": options or {"direct": True, "rewrite": True},
                "brain": None, "result": None, "limits": [],
                "work_dir": str(wd), "cancel": False, "permit": False,
                "created": time.time(), "touched": time.time()}

    def _stubs(self, *, speak=None, mux=None, duration=20.0):
        def _download(url, wd, **kw):
            p = Path(wd) / "in.mp4"
            p.write_bytes(b"video")
            return p

        return dict(
            download=mock.patch.object(revoice_api.ingest_url, "download_video",
                                       side_effect=_download),
            probe=mock.patch.object(revoice_api.frames, "probe_video",
                                    return_value={"duration": duration,
                                                  "width": 640, "height": 360}),
            brain=mock.patch.object(revoice_api.brain_mod, "make_brain",
                                    return_value=_Mind()),
            emap=mock.patch.object(revoice_api, "emotion_map",
                                   return_value={"baseline": "v1"}),
            pmap=mock.patch.object(revoice_api, "prosody_map",
                                   return_value={}),
            resolve=mock.patch.object(revoice_api, "resolve",
                                      return_value=("v1", "baseline", False)),
            speak=mock.patch.object(
                revoice_api, "_engine_speak",
                **({"side_effect": speak} if speak
                   else {"return_value": (_wav(2.0), 2.0)})),
            mux=mock.patch.object(
                revoice_api.voiceover, "mux",
                side_effect=mux or (lambda v, t, o: Path(o).write_bytes(b"mp4"))),
        )

    def _run(self, job, stubs):
        with ExitStack() as stack:
            for p in stubs.values():
                stack.enter_context(p)
            revoice_api._run_job(job)
        return job

    # ── the happy path ────────────────────────────────────────────────────
    def test_the_happy_path_lands_done_with_artifacts(self) -> None:
        with TemporaryDirectory() as td:
            job = self._run(self._job(td), self._stubs())
            self.assertIsNone(job["error"])
            self.assertEqual(job["status"], "done")
            self.assertEqual([s["state"] for s in job["steps"]], ["done"] * 4)
            wd = Path(job["work_dir"])
            for name in ("track.wav", "fit.json", "revoiced.mp4"):
                self.assertTrue((wd / name).is_file(), name)
            self.assertEqual(job["brain"], {"backend": "test"})
            self.assertEqual(job["result"]["summary"]["lines"], 2)
            self.assertEqual(job["result"]["summary"]["failed"], 0)

    def test_the_steps_run_in_their_declared_order(self) -> None:
        seen: list[str] = []
        real_step = revoice_api._step

        def spy(job, key, state):
            if state == "active":
                seen.append(key)
            real_step(job, key, state)

        with TemporaryDirectory() as td, \
                mock.patch.object(revoice_api, "_step", spy):
            self._run(self._job(td), self._stubs())
        self.assertEqual(seen, [k for k, _ in revoice_api.STEPS])

    def test_fit_json_on_disk_is_the_polled_report(self) -> None:
        with TemporaryDirectory() as td:
            job = self._run(self._job(td), self._stubs())
            on_disk = json.loads(
                (Path(job["work_dir"]) / "fit.json").read_text("utf-8"))
        self.assertEqual(on_disk, job["result"]["fit"])

    # ── the expensive failures ────────────────────────────────────────────
    def test_a_mux_that_dies_after_a_full_speak_pass_is_an_error(self) -> None:
        def boom(v, t, o):
            raise voiceover.VoiceoverError(
                "the narrated video could not be assembled")

        with TemporaryDirectory() as td:
            job = self._run(self._job(td), self._stubs(mux=boom))
        self.assertEqual(job["status"], "error")
        self.assertIsNone(job["result"])
        self.assertIn("could not be assembled", job["error"])
        self.assertNotIn("Traceback", job["error"])

    def test_every_line_failing_is_never_a_healthy_done(self) -> None:
        def refuse(voice_id, text):
            raise RuntimeError("engine sad")

        with TemporaryDirectory() as td:
            job = self._run(self._job(td), self._stubs(speak=refuse))
            self.assertFalse((Path(job["work_dir"]) / "revoiced.mp4").exists())
        self.assertEqual(job["status"], "error")
        self.assertIn("not one line", job["error"])
        self.assertNotIn("engine sad", job["error"])

    def test_one_failed_line_still_produces_the_video(self) -> None:
        calls = {"n": 0}

        def flaky(voice_id, text):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("engine sad")
            return _wav(2.0), 2.0

        with TemporaryDirectory() as td:
            job = self._run(self._job(td), self._stubs(speak=flaky))
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["result"]["summary"]["failed"], 1)
        self.assertEqual(job["result"]["fit"][0]["error"],
                         "this line could not be re-performed")

    # ── cancel ────────────────────────────────────────────────────────────
    def test_cancel_mid_speak_stops_before_the_mux(self) -> None:
        job_ref: dict = {}

        def speak(voice_id, text):
            job_ref["job"]["cancel"] = True
            return _wav(2.0), 2.0

        with TemporaryDirectory() as td:
            job = self._job(td)
            job_ref["job"] = job
            self._run(job, self._stubs(speak=speak))
            self.assertFalse((Path(job["work_dir"]) / "revoiced.mp4").exists())
        self.assertEqual(job["status"], "cancelled")
        self.assertIsNone(job["result"])
        self.assertIsNone(job["error"])

    def test_a_cancel_during_mux_is_not_overwritten_by_done(self) -> None:
        """Terminal-state uniqueness: the real DELETE door fires while the
        phase thread is inside mux; the thread must not stamp `done` over it."""
        with TemporaryDirectory() as td:
            job = self._job(td)
            with revoice_api._LOCK:
                revoice_api.JOBS[job["id"]] = job
            try:
                def late_cancel(v, t, o):
                    Path(o).write_bytes(b"mp4")
                    revoice_api.cancel(job["id"])

                self._run(job, self._stubs(mux=late_cancel))
            finally:
                with revoice_api._LOCK:
                    revoice_api.JOBS.pop(job["id"], None)
        self.assertEqual(job["status"], "cancelled")
        self.assertIsNone(job["result"])

    # ── the post-mux truth (what is actually in the mp4) ──────────────────
    def test_a_line_clipped_at_the_video_end_says_so(self) -> None:
        # slot 8-12s in a 10s video, spoken for 4s: 2s of it fall off the end.
        with TemporaryDirectory() as td:
            job = self._run(
                self._job(td, lines=[(0.0, 4.0), (8.0, 12.0)]),
                self._stubs(speak=lambda v, t: (_wav(4.0), 4.0), duration=10.0))
        self.assertEqual(job["status"], "done")
        first, last = job["result"]["fit"]
        self.assertEqual(first["track_clipped_seconds"], 0.0)
        self.assertAlmostEqual(last["track_clipped_seconds"], 2.0, places=1)
        self.assertTrue(last["in_track"])
        self.assertEqual(job["result"]["summary"]["clipped"], 1)

    def test_the_estimate_and_the_track_truth_are_both_kept(self) -> None:
        with TemporaryDirectory() as td:
            job = self._run(
                self._job(td, lines=[(0.0, 4.0), (8.0, 12.0)]),
                self._stubs(speak=lambda v, t: (_wav(4.0), 4.0), duration=10.0))
        last = job["result"]["fit"][1]
        # the ladder saw a line that fits its 4s slot; the TRACK lost 2s of it
        self.assertEqual(last["spill_seconds"], 0.0)
        self.assertGreater(last["track_clipped_seconds"], 0.0)
        self.assertIn("track_spill_seconds", last)

    def test_a_failed_line_is_not_counted_as_audible(self) -> None:
        def refuse_first(voice_id, text):
            if text.endswith("0"):
                raise RuntimeError("engine sad")
            return _wav(2.0), 2.0

        with TemporaryDirectory() as td:
            job = self._run(self._job(td), self._stubs(speak=refuse_first))
        fit = job["result"]["fit"]
        self.assertFalse(fit[0]["in_track"])
        self.assertTrue(fit[1]["in_track"])
        self.assertEqual(job["result"]["summary"]["silent_in_track"], 1)


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
