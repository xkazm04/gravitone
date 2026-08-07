"""The voiceover pipeline — plan cleaning, track fit arithmetic, and one
whole job run with every external seam stubbed (no network, no engine, no
ffmpeg). The fit report is the honesty surface here: spill, clip and silence
must be measured facts, never vibes.
"""
from __future__ import annotations

import io
import json
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

    def _stubs(self, described=None):
        scenes = [frames_scene(0, 0.0, 10.0), frames_scene(1, 10.0, 20.0)]

        class _Mind:
            def describe(self):
                return {"backend": "test"}

            def complete_json(self, prompt):
                return {"lines": [
                    {"scene": 0, "text": "Line one.", "emotion": "baseline"},
                    {"scene": 1, "text": "", "emotion": "baseline"}]}

        return dict(
            make_brain=mock.patch.object(voiceover_api.brain_mod, "make_brain",
                                         return_value=_Mind()),
            probe=mock.patch.object(voiceover_api.frames, "probe_video",
                                    return_value={"duration": 20.0,
                                                  "width": 640, "height": 360}),
            detect=mock.patch.object(voiceover_api.frames, "detect_scenes",
                                     return_value=scenes),
            capture=mock.patch.object(voiceover_api.frames, "capture_frames",
                                      side_effect=lambda v, s, d, **k: s),
            look=mock.patch.object(voiceover_api.vision, "describe_scenes",
                                   return_value=described if described is not None
                                   else [{"caption": "a"}, {"caption": "b"}]),
            speak=mock.patch.object(voiceover_api, "_engine_speak",
                                    return_value=(_wav(2.0), 2.0)),
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
            for p in stubs.values():
                stack.enter_context(p)
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


def frames_scene(i: int, start: float, end: float):
    from service.frames import Scene
    return Scene(i=i, start=start, end=end)


if __name__ == "__main__":
    unittest.main()
