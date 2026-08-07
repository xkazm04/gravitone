"""Scene segmentation and frame capture — the pure arithmetic and the tool
seams. Nothing here runs a real ffmpeg decode: `frames._run` is the double,
same convention as `ingest_url._run`. The one contract everything downstream
leans on: scenes tile the video exactly (no gaps, no overlap) and respect the
5-30 s narration bounds.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service import frames


class _FakeRun:
    def __init__(self, returncode: int = 0, stdout: bytes = b"",
                 stderr: bytes = b"", write: Path | None = None) -> None:
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr
        self.write = write
        self.calls: list[list[str]] = []

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        if self.write is not None:
            # frame capture: the output path is the last argv element
            Path(cmd[-1]).write_bytes(b"\xff\xd8jpeg")
        return self


class CoalesceTests(unittest.TestCase):
    def test_fragments_under_min_are_merged_into_a_neighbour(self) -> None:
        out = frames._coalesce([0.0, 2.0, 11.0, 20.0], min_s=5, max_s=30)
        self.assertEqual(out, [0.0, 11.0, 20.0])

    def test_stretches_over_max_are_split_evenly(self) -> None:
        out = frames._coalesce([0.0, 70.0], min_s=5, max_s=30)
        self.assertEqual(len(out), 4)                    # 3 pieces ≈ 23.3 s
        spans = [b - a for a, b in zip(out, out[1:])]
        self.assertTrue(all(s <= 30.0 + 1e-6 for s in spans))
        self.assertTrue(all(s >= 5.0 for s in spans))

    def test_scenes_tile_the_video_exactly(self) -> None:
        bounds = frames._coalesce([0.0, 1.0, 6.5, 6.9, 40.0, 90.0],
                                  min_s=5, max_s=30)
        self.assertEqual(bounds[0], 0.0)
        self.assertEqual(bounds[-1], 90.0)
        self.assertEqual(bounds, sorted(bounds))

    def test_a_cut_too_close_to_the_end_is_dropped(self) -> None:
        # keeping 58.0 would leave a 2 s tail scene
        out = frames._coalesce([0.0, 30.0, 58.0, 60.0], min_s=5, max_s=30)
        self.assertEqual(out, [0.0, 30.0, 60.0])


class DetectTests(unittest.TestCase):
    def test_showinfo_timestamps_become_bounded_scenes(self) -> None:
        stderr = (b"[Parsed_showinfo] n:0 pts_time:12.512 pos:1\n"
                  b"[Parsed_showinfo] n:1 pts_time:31.04 pos:2\n")
        fake = _FakeRun(stderr=stderr)
        with mock.patch.object(frames, "_run", fake):
            scenes = frames.detect_scenes(Path("v.mp4"), duration=45.0)
        self.assertEqual([(s.start, s.end) for s in scenes],
                         [(0.0, 12.512), (12.512, 31.04), (31.04, 45.0)])
        self.assertEqual([s.i for s in scenes], [0, 1, 2])

    def test_a_video_with_no_cuts_is_still_scened(self) -> None:
        with mock.patch.object(frames, "_run", _FakeRun()):
            scenes = frames.detect_scenes(Path("v.mp4"), duration=65.0)
        self.assertEqual(len(scenes), 3)                 # 65 s → ≤30 s chunks
        self.assertEqual(scenes[-1].end, 65.0)

    def test_a_detector_failure_is_named_not_leaked(self) -> None:
        fake = _FakeRun(returncode=1, stderr=b"/home/op/secret: decode error")
        with mock.patch.object(frames, "_run", fake):
            with self.assertRaises(frames.FramesError) as ctx:
                frames.detect_scenes(Path("v.mp4"), duration=10.0)
        self.assertNotIn("secret", str(ctx.exception))


class CaptureTests(unittest.TestCase):
    def test_each_scene_gets_one_jpeg_at_its_midpoint(self) -> None:
        with TemporaryDirectory() as td:
            fake = _FakeRun(write=Path(td))
            scenes = [frames.Scene(0, 0.0, 10.0), frames.Scene(1, 10.0, 30.0)]
            with mock.patch.object(frames, "_run", fake):
                out = frames.capture_frames(Path("v.mp4"), scenes, Path(td))
            self.assertTrue(all(s.frame is not None for s in out))
            self.assertIsNone(out[0].frame_error)
            # midpoint seek: -ss 5.000 for the first scene
            self.assertIn("5.000", fake.calls[0])

    def test_one_bad_frame_degrades_that_scene_only(self) -> None:
        calls = {"n": 0}

        class _Flaky:
            returncode = 0
            stderr = b""

            def __call__(self, cmd, **kw):
                calls["n"] += 1
                if calls["n"] == 1:
                    return type("R", (), {"returncode": 1, "stderr": b"x"})()
                Path(cmd[-1]).write_bytes(b"\xff\xd8jpeg")
                return type("R", (), {"returncode": 0, "stderr": b""})()

        with TemporaryDirectory() as td:
            scenes = [frames.Scene(0, 0.0, 10.0), frames.Scene(1, 10.0, 20.0)]
            with mock.patch.object(frames, "_run", _Flaky()):
                out = frames.capture_frames(Path("v.mp4"), scenes, Path(td))
            self.assertIsNone(out[0].frame)
            self.assertIsNotNone(out[0].frame_error)
            self.assertIsNotNone(out[1].frame)

    def test_public_shape_serves_no_paths(self) -> None:
        s = frames.Scene(3, 1.234, 8.9, frame=Path("C:/secret/scene.jpg"))
        pub = s.public()
        self.assertEqual(pub, {"i": 3, "start": 1.23, "end": 8.9,
                               "dur": 7.666, "has_frame": True,
                               "frame_error": None})
        self.assertNotIn("frame", pub)


if __name__ == "__main__":
    unittest.main()
