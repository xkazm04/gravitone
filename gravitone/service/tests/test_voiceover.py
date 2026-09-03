"""The voiceover pipeline — plan cleaning, track fit arithmetic, and one
whole job run with every external seam stubbed (no network, no engine, no
ffmpeg). The fit report is the honesty surface here: spill, clip and silence
must be measured facts, never vibes.
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

import numpy as np

from service import voiceover
from service import voiceover_api


def _scenes(*bounds: tuple[float, float]) -> list[dict]:
    return [{"i": i, "start": a, "end": b, "dur": round(b - a, 2),
             "frame": None} for i, (a, b) in enumerate(bounds)]


def _wav(seconds: float, rate: int = voiceover.RATE) -> bytes:
    pcm = (np.ones(int(seconds * rate)) * 0.25 * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class CleanScriptTests(unittest.TestCase):
    SCENES = _scenes((0, 10), (10, 22))

    def test_a_missing_scene_is_silence_not_an_error(self) -> None:
        lines = voiceover.clean_script(
            {"lines": [{"scene": 1, "text": "Hi.", "emotion": "baseline"}]},
            self.SCENES, emotions=["baseline"])
        self.assertEqual([l["text"] for l in lines], ["", "Hi."])

    def test_an_invented_emotion_falls_to_baseline_visibly(self) -> None:
        lines = voiceover.clean_script(
            {"lines": [{"scene": 0, "text": "x", "emotion": "bombastic"}]},
            self.SCENES, emotions=["baseline", "calm"])
        self.assertEqual(lines[0]["emotion"], "baseline")
        self.assertEqual(lines[0]["emotion_requested"], "bombastic")

    def test_a_known_emotion_survives_untouched(self) -> None:
        lines = voiceover.clean_script(
            {"lines": [{"scene": 0, "text": "x", "emotion": "calm"}]},
            self.SCENES, emotions=["baseline", "calm"])
        self.assertEqual(lines[0]["emotion"], "calm")
        self.assertIsNone(lines[0]["emotion_requested"])

    def test_the_word_budget_rides_along(self) -> None:
        lines = voiceover.clean_script({"lines": []}, self.SCENES,
                                       emotions=["baseline"])
        self.assertEqual(lines[0]["budget_words"], voiceover.words_budget(10))


class BuildTrackTests(unittest.TestCase):
    def test_lines_land_at_their_scene_starts(self) -> None:
        scenes = _scenes((0, 10), (10, 20))
        lines = [{"scene": 1, "text": "hello", "emotion": "baseline",
                  "wav": _wav(2.0), "seconds": 2.0}]
        track, fit = voiceover.build_track(lines, scenes, video_seconds=20)
        with wave.open(io.BytesIO(track), "rb") as w:
            data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
        rate = voiceover.RATE
        self.assertEqual(len(data), 20 * rate)
        self.assertEqual(int(np.abs(data[:10 * rate]).max()), 0)   # scene 0 quiet
        self.assertGreater(int(np.abs(data[10 * rate:12 * rate]).max()), 1000)

    def test_spill_into_the_next_scene_is_measured_not_cut(self) -> None:
        scenes = _scenes((0, 5), (5, 15))
        lines = [{"scene": 0, "text": "long", "emotion": "baseline",
                  "wav": _wav(7.0), "seconds": 7.0}]
        _, fit = voiceover.build_track(lines, scenes, video_seconds=15)
        self.assertAlmostEqual(fit[0]["spill_seconds"], 2.0, places=1)
        self.assertEqual(fit[0]["clipped_seconds"], 0.0)

    def test_running_past_the_video_end_is_clipped_and_says_so(self) -> None:
        scenes = _scenes((0, 8))
        lines = [{"scene": 0, "text": "long", "emotion": "baseline",
                  "wav": _wav(12.0), "seconds": 12.0}]
        _, fit = voiceover.build_track(lines, scenes, video_seconds=8)
        self.assertAlmostEqual(fit[0]["clipped_seconds"], 4.0, places=1)

    def test_spill_names_the_scenes_it_steps_on(self) -> None:
        """A 12s line at a 5s scene plays over the two scenes that follow it.
        The aggregate says HOW MUCH; the attribution says ON WHOM."""
        scenes = _scenes((0, 5), (5, 10), (10, 15), (15, 20))
        lines = [{"scene": 0, "text": "long", "emotion": "baseline",
                  "wav": _wav(12.0), "seconds": 12.0}]
        lines += [{"scene": i, "text": "", "emotion": "baseline"}
                  for i in (1, 2, 3)]
        _, fit = voiceover.build_track(lines, scenes, video_seconds=20)
        self.assertAlmostEqual(fit[0]["spill_seconds"], 7.0, places=1)
        self.assertEqual(fit[0]["spills_into"],
                         [{"scene": 1, "seconds": 5.0},
                          {"scene": 2, "seconds": 2.0}])
        self.assertEqual(fit[1]["spilled_over_by"],
                         [{"scene": 0, "seconds": 5.0}])
        self.assertEqual(fit[2]["spilled_over_by"],
                         [{"scene": 0, "seconds": 2.0}])
        self.assertEqual(fit[3]["spilled_over_by"], [])
        self.assertEqual(voiceover.summarize(fit)["spilled_on"], 2)

    def test_a_line_that_fits_steps_on_nobody(self) -> None:
        scenes = _scenes((0, 10), (10, 20))
        lines = [{"scene": 0, "text": "ok", "emotion": "baseline",
                  "wav": _wav(3.0), "seconds": 3.0},
                 {"scene": 1, "text": "", "emotion": "baseline"}]
        _, fit = voiceover.build_track(lines, scenes, video_seconds=20)
        self.assertEqual(fit[0]["spills_into"], [])
        self.assertEqual(fit[1]["spilled_over_by"], [])
        self.assertEqual(voiceover.summarize(fit)["spilled_on"], 0)

    def test_attribution_stops_at_the_video_end_like_the_audio_does(self) -> None:
        """Only what is IN the track is attributed: seconds clipped off the end
        of the video never played over anything."""
        scenes = _scenes((0, 5), (5, 10))
        lines = [{"scene": 0, "text": "long", "emotion": "baseline",
                  "wav": _wav(12.0), "seconds": 12.0},
                 {"scene": 1, "text": "", "emotion": "baseline"}]
        _, fit = voiceover.build_track(lines, scenes, video_seconds=10)
        self.assertAlmostEqual(fit[0]["clipped_seconds"], 2.0, places=1)
        self.assertEqual(fit[0]["spills_into"],
                         [{"scene": 1, "seconds": 5.0}])

    def test_a_failed_line_is_a_named_entry_not_a_hole(self) -> None:
        scenes = _scenes((0, 10))
        lines = [{"scene": 0, "text": "x", "emotion": "baseline",
                  "error": "this line could not be synthesized"}]
        _, fit = voiceover.build_track(lines, scenes, video_seconds=10)
        self.assertEqual(fit[0]["error"], "this line could not be synthesized")

    def test_summarize_counts_what_the_studio_renders(self) -> None:
        scenes = _scenes((0, 5), (5, 10), (10, 15))
        lines = [
            {"scene": 0, "text": "a", "emotion": "baseline",
             "wav": _wav(6.0), "seconds": 6.0},
            {"scene": 1, "text": "", "emotion": "baseline"},
            {"scene": 2, "text": "c", "emotion": "baseline",
             "error": "boom"},
        ]
        _, fit = voiceover.build_track(lines, scenes, video_seconds=15)
        s = voiceover.summarize(fit)
        self.assertEqual((s["scenes"], s["spoken"], s["silent"], s["failed"]),
                         (3, 1, 1, 1))
        self.assertEqual(s["spilling"], 1)


class SynthesizeLinesTests(unittest.TestCase):
    def test_one_refused_line_degrades_to_named_silence(self) -> None:
        lines = [{"scene": 0, "text": "ok", "emotion": "baseline"},
                 {"scene": 1, "text": "bad", "emotion": "baseline"}]

        def speak(voice_id, text):
            if text == "bad":
                raise RuntimeError("engine sad")
            return _wav(1.0), 1.0

        out = voiceover.synthesize_lines(
            lines, speak=speak,
            resolve_voice=lambda e: ("v1", e, False))
        self.assertIn("wav", out[0])
        self.assertNotIn("wav", out[1])
        self.assertEqual(out[1]["error"], "this line could not be synthesized")

    def test_a_timeout_is_named_apart_from_a_refusal(self) -> None:
        lines = [{"scene": 0, "text": "slow", "emotion": "baseline"},
                 {"scene": 1, "text": "bad", "emotion": "baseline"}]

        def speak(voice_id, text):
            if text == "slow":
                raise voiceover.EngineTimeout("deadline")
            raise RuntimeError("engine sad")

        out = voiceover.synthesize_lines(
            lines, speak=speak, resolve_voice=lambda e: ("v1", e, False))
        self.assertTrue(out[0]["timed_out"])
        self.assertIn("in time", out[0]["error"])
        self.assertNotIn("timed_out", out[1])
        self.assertEqual(out[1]["error"], "this line could not be synthesized")

    def test_a_wedged_engine_abandons_the_script_after_the_threshold(self) -> None:
        lines = [{"scene": i, "text": f"line {i}", "emotion": "baseline"}
                 for i in range(10)]
        calls = []

        def speak(voice_id, text):
            calls.append(text)
            raise voiceover.EngineTimeout("deadline")

        with self.assertRaises(voiceover.errors.UserFacing) as caught:
            voiceover.synthesize_lines(
                lines, speak=speak, resolve_voice=lambda e: ("v1", e, False))
        self.assertEqual(len(calls), voiceover.MAX_CONSECUTIVE_TIMEOUTS)
        self.assertIn("stopped answering", str(caught.exception))
        self.assertNotIn("deadline", str(caught.exception))

    def test_a_line_that_speaks_resets_the_streak(self) -> None:
        """Isolated timeouts, spread through a working script, are survivable —
        the fail-fast is about the SYSTEMIC case only."""
        lines = [{"scene": i, "text": f"line {i}", "emotion": "baseline"}
                 for i in range(9)]

        def speak(voice_id, text):
            if int(text.split()[1]) % 2:      # every other line stalls
                raise voiceover.EngineTimeout("deadline")
            return _wav(1.0), 1.0

        out = voiceover.synthesize_lines(
            lines, speak=speak, resolve_voice=lambda e: ("v1", e, False))
        self.assertEqual(sum(1 for l in out if l.get("wav")), 5)
        self.assertEqual(sum(1 for l in out if l.get("timed_out")), 4)

    def test_a_refusal_is_not_evidence_the_engine_is_alive(self) -> None:
        """A fast refusal between two timeouts must not reset the streak: the
        engine answering 'no' instantly says nothing about whether it can
        answer 'yes'."""
        lines = [{"scene": i, "text": f"line {i}", "emotion": "baseline"}
                 for i in range(6)]

        def speak(voice_id, text):
            if text == "line 1":
                raise RuntimeError("engine sad")
            raise voiceover.EngineTimeout("deadline")

        with self.assertRaises(voiceover.errors.UserFacing):
            voiceover.synthesize_lines(
                lines, speak=speak, resolve_voice=lambda e: ("v1", e, False))

    def test_silent_lines_cost_no_engine_call(self) -> None:
        calls = []
        voiceover.synthesize_lines(
            [{"scene": 0, "text": "", "emotion": "baseline"}],
            speak=lambda v, t: calls.append(t) or (_wav(1), 1.0),
            resolve_voice=lambda e: ("v1", e, False))
        self.assertEqual(calls, [])


class JobRunTests(unittest.TestCase):
    """One whole `_run_job` with every seam stubbed. What this pins: step
    order, the honesty limits, and that a job ends in exactly one terminal
    state with its artifacts on disk."""

    def _job(self, td: str) -> dict:
        wd = Path(td) / "job"
        wd.mkdir()
        return {"id": "t1", "status": "running", "step": "fetch",
                "steps": [{"key": k, "label": l, "state": "pending"}
                          for k, l in voiceover_api.STEPS],
                "partial": {}, "error": None,
                "source": {"kind": "upload", "title": "clip",
                           "path": str(wd / "in.mp4")},
                "character_id": "ada", "style": "", "language": "",
                "brain": None, "result": None, "limits": [],
                "work_dir": str(wd), "cancel": False,
                "created": 0.0, "touched": 0.0}

    def _stubs(self, described=None, *, texts=("Line one.", ""), speak=None):
        n = len(texts)
        scenes = [frames_scene(i, i * 10.0, (i + 1) * 10.0) for i in range(n)]

        class _Mind:
            def describe(self):
                return {"backend": "test"}

            def complete_json(self, prompt):
                return {"lines": [{"scene": i, "text": t,
                                   "emotion": "baseline"}
                                  for i, t in enumerate(texts)]}

        return dict(
            make_brain=mock.patch.object(voiceover_api.brain_mod, "make_brain",
                                         return_value=_Mind()),
            probe=mock.patch.object(voiceover_api.frames, "probe_video",
                                    return_value={"duration": n * 10.0,
                                                  "width": 640, "height": 360}),
            detect=mock.patch.object(voiceover_api.frames, "detect_scenes",
                                     return_value=scenes),
            capture=mock.patch.object(voiceover_api.frames, "capture_frames",
                                      side_effect=lambda v, s, d, **k: s),
            look=mock.patch.object(voiceover_api.vision, "describe_scenes",
                                   return_value=described if described is not None
                                   else [{"caption": "a"}] * n),
            speak=mock.patch.object(
                voiceover_api, "_engine_speak",
                **({"side_effect": speak} if speak
                   else {"return_value": (_wav(2.0), 2.0)})),
            emap=mock.patch.object(voiceover_api, "emotion_map",
                                   return_value={"baseline": "v1"}),
            pmap=mock.patch.object(voiceover_api, "prosody_map",
                                   return_value={}),
            mux=mock.patch.object(voiceover_api.voiceover, "mux",
                                  side_effect=lambda v, t, o:
                                  Path(o).write_bytes(b"mp4")),
        )

    def _run(self, job, stubs):
        from contextlib import ExitStack
        with ExitStack() as stack:
            # kept for assertions ABOUT the seams (was anything even called?)
            self.mocks = {k: stack.enter_context(p) for k, p in stubs.items()}
            voiceover_api._run_job(job)
        return job

    def test_the_happy_path_lands_done_with_artifacts(self) -> None:
        with TemporaryDirectory() as td:
            job = self._run(self._job(td), self._stubs())
            self.assertIsNone(job["error"])
            self.assertEqual(job["status"], "done")
            self.assertEqual([s["state"] for s in job["steps"]], ["done"] * 6)
            wd = Path(job["work_dir"])
            for name in ("scenes.json", "script.json", "track.wav",
                         "narrated.mp4"):
                self.assertTrue((wd / name).is_file(), name)
            self.assertEqual(job["result"]["summary"]["spoken"], 1)
            self.assertEqual(job["brain"], {"backend": "test"})

    def test_partially_blind_video_narrates_with_a_named_limit(self) -> None:
        with TemporaryDirectory() as td:
            job = self._run(self._job(td),
                            self._stubs(described=[{"caption": "a"}, None]))
            self.assertEqual(job["status"], "done")
            self.assertTrue(any("narrated blind" in l for l in job["limits"]))

    def test_a_fully_blind_video_fails_with_an_authored_sentence(self) -> None:
        with TemporaryDirectory() as td:
            job = self._run(self._job(td),
                            self._stubs(described=[None, None]))
            self.assertEqual(job["status"], "error")
            self.assertIn("vision pass failed", job["error"])
            self.assertNotIn("Traceback", job["error"])

    def test_one_line_timing_out_still_produces_the_video(self) -> None:
        def speak(voice_id, text):
            if text == "Line one.":
                raise voiceover.EngineTimeout("deadline")
            return _wav(2.0), 2.0

        with TemporaryDirectory() as td:
            job = self._run(self._job(td), self._stubs(
                texts=("Line one.", "Line two."), speak=speak))
            self.assertTrue((Path(job["work_dir"]) / "narrated.mp4").is_file())
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["result"]["summary"]["failed"], 1)
        self.assertEqual(job["result"]["summary"]["spoken"], 1)

    def test_a_wedged_engine_fails_before_the_mux_is_spent(self) -> None:
        """The systemic case: every line burns the full per-line deadline, so
        running the script out costs `120s x scenes` and produces nothing."""
        def speak(voice_id, text):
            raise voiceover.EngineTimeout("deadline")

        with TemporaryDirectory() as td:
            stubs = self._stubs(texts=tuple(f"Line {i}." for i in range(8)),
                                speak=speak)
            job = self._run(self._job(td), stubs)
            wd = Path(job["work_dir"])
            self.assertFalse((wd / "narrated.mp4").exists())
            self.assertFalse((wd / "track.wav").exists())
        self.assertEqual(self.mocks["mux"].call_count, 0,
                         "the mux ran anyway — the fail-fast came too late")
        self.assertEqual(self.mocks["speak"].call_count,
                         voiceover.MAX_CONSECUTIVE_TIMEOUTS)
        self.assertEqual(job["status"], "error")
        self.assertIn("stopped answering", job["error"])
        self.assertNotIn("Traceback", job["error"])
        self.assertNotIn("deadline", job["error"])

    def test_a_cancel_during_mux_is_not_overwritten_by_done(self) -> None:
        """Terminal-state uniqueness: the real DELETE door fires while the
        phase thread is inside mux; the thread must not stamp `done` over it."""
        with TemporaryDirectory() as td:
            job = self._job(td)
            job["created"] = job["touched"] = time.time()
            with voiceover_api._LOCK:
                voiceover_api.JOBS[job["id"]] = job
            try:
                def late_cancel(v, t, o):
                    Path(o).write_bytes(b"mp4")
                    voiceover_api.cancel(job["id"])

                stubs = self._stubs()
                stubs["mux"] = mock.patch.object(voiceover_api.voiceover, "mux",
                                                 side_effect=late_cancel)
                self._run(job, stubs)
            finally:
                with voiceover_api._LOCK:
                    voiceover_api.JOBS.pop(job["id"], None)
        self.assertEqual(job["status"], "cancelled")
        self.assertIsNone(job["result"])


class AdmissionTests(unittest.TestCase):
    """The door is a HELD permit. A worker that dies without reaching an
    `except` must not leave MAX_ACTIVE shut for the whole running-TTL."""

    def setUp(self) -> None:
        admit = mock.patch.object(voiceover_api, "_ADMIT",
                                  threading.BoundedSemaphore(1))
        admit.start()
        self.addCleanup(admit.stop)

    def _job(self, td: str) -> dict:
        wd = Path(td) / "job"
        wd.mkdir(exist_ok=True)
        return {"id": "a1", "status": "running", "step": "fetch",
                "steps": [{"key": k, "label": l, "state": "pending"}
                          for k, l in voiceover_api.STEPS],
                "partial": {}, "error": None,
                "source": {"kind": "upload", "title": "clip",
                           "path": str(wd / "in.mp4")},
                "character_id": "ada", "style": "", "language": "",
                "brain": None, "result": None, "limits": [],
                "work_dir": str(wd), "cancel": False, "permit": True,
                "created": 0.0, "touched": 0.0}

    def test_a_worker_killed_by_a_base_exception_frees_the_door(self) -> None:
        self.assertTrue(voiceover_api._acquire_admission())
        with TemporaryDirectory() as td:
            job = self._job(td)
            with mock.patch.object(voiceover_api.brain_mod, "make_brain",
                                   side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    voiceover_api._run_job(job)
            # the job is still wedged at "running" — that is exactly why the
            # door may not be derived from job status
            self.assertEqual(job["status"], "running")
        self.assertTrue(voiceover_api._acquire_admission(),
                        "the permit was not returned by the finally")

    def test_the_permit_comes_back_exactly_once(self) -> None:
        self.assertTrue(voiceover_api._acquire_admission())
        with TemporaryDirectory() as td:
            job = self._job(td)
            voiceover_api._release_admission(job)
            voiceover_api._release_admission(job)  # a no-op, not a boom
        self.assertTrue(voiceover_api._acquire_admission())
        self.assertFalse(voiceover_api._acquire_admission())


class ReapTests(unittest.TestCase):
    """Cancelling a finished job must not pull narrated.mp4 out from under a
    download that is already streaming: deletion is deferred to `_gc`."""

    def setUp(self) -> None:
        reap = mock.patch.object(voiceover_api, "_REAP", [])
        reap.start()
        self.addCleanup(reap.stop)

    def test_cancel_on_a_terminal_job_defers_the_delete(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td) / "job"
            wd.mkdir()
            (wd / "narrated.mp4").write_bytes(b"mp4")
            job = {"id": "v1", "status": "done", "work_dir": str(wd),
                   "cancel": False, "created": time.time(),
                   "touched": time.time()}
            with voiceover_api._LOCK:
                voiceover_api.JOBS[job["id"]] = job
            try:
                voiceover_api.cancel("v1")
                self.assertNotIn("v1", voiceover_api.JOBS)
                self.assertTrue((wd / "narrated.mp4").is_file(),
                                "the artifact was deleted under a live reader")
                self.assertEqual(len(voiceover_api._REAP), 1)
                voiceover_api._REAP[:] = [(0.0, str(wd))]
                voiceover_api._gc()
                self.assertFalse(wd.exists())
            finally:
                with voiceover_api._LOCK:
                    voiceover_api.JOBS.pop("v1", None)

    def test_cancel_on_a_running_job_never_touches_its_work_dir(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td) / "job"
            wd.mkdir()
            (wd / "track.wav").write_bytes(b"wav")
            job = {"id": "v2", "status": "running", "work_dir": str(wd),
                   "cancel": False, "created": time.time(),
                   "touched": time.time()}
            with voiceover_api._LOCK:
                voiceover_api.JOBS[job["id"]] = job
            try:
                voiceover_api.cancel("v2")
                self.assertEqual(job["status"], "cancelled")
                self.assertTrue(job["cancel"])
                self.assertTrue((wd / "track.wav").is_file())
                self.assertEqual(voiceover_api._REAP, [])
            finally:
                with voiceover_api._LOCK:
                    voiceover_api.JOBS.pop("v2", None)


def frames_scene(i: int, start: float, end: float):
    from service.frames import Scene
    return Scene(i=i, start=start, end=end)


if __name__ == "__main__":
    unittest.main()
