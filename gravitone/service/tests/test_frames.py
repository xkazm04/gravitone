"""Scene segmentation and frame capture — the pure arithmetic and the tool
seams. Nothing here runs a real ffmpeg decode: `frames._run` is the double,
same convention as `ingest_url._run`. The one contract everything downstream
leans on: scenes tile the video exactly (no gaps, no overlap) and respect the
5-30 s narration bounds.
"""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service import frames


def _sig(fill: int = 100) -> bytes:
    """A flat signature raster of the size frames asks ffmpeg for."""
    return bytes([fill]) * (frames.SIG_GRID * frames.SIG_GRID)


def _jpeg_arg(cmd: list[str]) -> str | None:
    return next((a for a in cmd if str(a).endswith(".jpg")), None)


class _FakeRun:
    def __init__(self, returncode: int = 0, stdout: bytes = b"",
                 stderr: bytes = b"", write: Path | None = None,
                 stdouts: list[bytes] | None = None) -> None:
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr
        self.write = write
        self.stdouts = stdouts
        self.calls: list[list[str]] = []

    def __call__(self, cmd, **kwargs):
        self.calls.append(cmd)
        if self.write is not None:
            # frame capture: the JPEG output, not the raw signature on stdout
            Path(_jpeg_arg(cmd)).write_bytes(b"\xff\xd8jpeg")
        if self.stdouts is not None:
            self.stdout = self.stdouts[min(len(self.calls) - 1,
                                           len(self.stdouts) - 1)]
        return self


class _FakePopen:
    """The detect seam: a process that finishes after `waits` polls, or never
    (`waits=None`) so the caller has to kill it."""

    def __init__(self, returncode: int = 0, stderr: bytes = b"",
                 waits: int | None = 0) -> None:
        self.returncode_when_done, self.stderr_data = returncode, stderr
        self.waits = waits
        self.polls = 0
        self.killed = False
        self.cmd: list[str] = []
        self._err = None
        self.returncode = None

    def __call__(self, cmd, stdin=None, stdout=None, stderr=None):
        self.cmd = cmd
        self._err = stderr
        return self

    def wait(self, timeout=None):
        self.polls += 1
        if self.waits is None or self.polls <= self.waits:
            raise subprocess.TimeoutExpired(self.cmd, timeout)
        self._err.write(self.stderr_data)
        self.returncode = self.returncode_when_done
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        self.waits = 0          # a killed process stops being busy


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
        fake = _FakePopen(stderr=stderr)
        with mock.patch.object(frames, "_popen", fake):
            scenes = frames.detect_scenes(Path("v.mp4"), duration=45.0)
        self.assertEqual([(s.start, s.end) for s in scenes],
                         [(0.0, 12.512), (12.512, 31.04), (31.04, 45.0)])
        self.assertEqual([s.i for s in scenes], [0, 1, 2])

    def test_a_video_with_no_cuts_is_still_scened(self) -> None:
        with mock.patch.object(frames, "_popen", _FakePopen()):
            scenes = frames.detect_scenes(Path("v.mp4"), duration=65.0)
        self.assertEqual(len(scenes), 3)                 # 65 s → ≤30 s chunks
        self.assertEqual(scenes[-1].end, 65.0)

    def test_a_detector_failure_is_named_not_leaked(self) -> None:
        fake = _FakePopen(returncode=1, stderr=b"/home/op/secret: decode error")
        with mock.patch.object(frames, "_popen", fake):
            with self.assertRaises(frames.FramesError) as ctx:
                frames.detect_scenes(Path("v.mp4"), duration=10.0)
        self.assertNotIn("secret", str(ctx.exception))


class DetectBoundsTests(unittest.TestCase):
    """Detection is interruptible and bounded by the caller's budget."""

    def test_only_the_budgeted_seconds_are_analysed(self) -> None:
        fake = _FakePopen()
        with mock.patch.object(frames, "_popen", fake):
            frames.detect_scenes(Path("v.mp4"), duration=900.0)
        self.assertIn("-t", fake.cmd)
        self.assertEqual(fake.cmd[fake.cmd.index("-t") + 1], "900.000")
        # ...and it is an INPUT-bounded pass, not a post-filter of the whole file
        self.assertLess(fake.cmd.index("-t"), fake.cmd.index("-vf"))

    def test_the_budget_scales_with_the_length_and_never_exceeds_the_old_cap(self) -> None:
        self.assertEqual(frames.detect_budget_s(10.0),
                         frames.DETECT_MIN_TIMEOUT_S)     # floored
        self.assertEqual(frames.detect_budget_s(60.0),
                         60.0 * frames.DETECT_SPEED_FACTOR)
        self.assertEqual(frames.detect_budget_s(100000.0),
                         frames.DETECT_TIMEOUT_S)         # capped
        self.assertEqual(frames.detect_budget_s(None),
                         frames.DETECT_TIMEOUT_S)

    def test_cancelling_kills_the_pass_instead_of_waiting_it_out(self) -> None:
        fake = _FakePopen(waits=None)                    # never finishes
        with mock.patch.object(frames, "_popen", fake), \
                mock.patch.object(frames, "DETECT_POLL_S", 0.0):
            scenes = frames.detect_scenes(Path("v.mp4"), duration=600.0,
                                          should_cancel=lambda: True)
        self.assertTrue(fake.killed)
        self.assertEqual(scenes, [])
        self.assertLessEqual(fake.polls, 2)              # not a 600 s wait

    def test_an_over_budget_pass_is_named_and_carries_no_tool_output(self) -> None:
        fake = _FakePopen(waits=None, stderr=b"/home/op/secret: slow decode")
        with mock.patch.object(frames, "_popen", fake), \
                mock.patch.object(frames, "DETECT_POLL_S", 0.0), \
                mock.patch.object(frames, "DETECT_MIN_TIMEOUT_S", 0.0), \
                mock.patch.object(frames, "DETECT_SPEED_FACTOR", 0.0):
            with self.assertRaises(frames.FramesError) as ctx:
                frames.detect_scenes(Path("v.mp4"), duration=4200.0)
        msg = str(ctx.exception)
        self.assertTrue(fake.killed)
        self.assertIn("4200", msg)                       # the length it gave up on
        self.assertNotIn("secret", msg)
        self.assertNotIn("decode", msg)


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
                Path(_jpeg_arg(cmd)).write_bytes(b"\xff\xd8jpeg")
                return type("R", (), {"returncode": 0, "stderr": b""})()

        with TemporaryDirectory() as td:
            scenes = [frames.Scene(0, 0.0, 10.0), frames.Scene(1, 10.0, 20.0)]
            with mock.patch.object(frames, "_run", _Flaky()):
                out = frames.capture_frames(Path("v.mp4"), scenes, Path(td))
            self.assertIsNone(out[0].frame)
            self.assertIsNotNone(out[0].frame_error)
            self.assertIsNotNone(out[1].frame)

    def test_public_shape_serves_no_paths(self) -> None:
        s = frames.Scene(3, 1.234, 8.9, frame=Path("C:/secret/scene.jpg"),
                         signature=_sig())
        pub = s.public()
        self.assertEqual(pub, {"i": 3, "start": 1.23, "end": 8.9,
                               "dur": 7.666, "has_frame": True,
                               "frame_error": None, "repeat_of": None})
        self.assertNotIn("frame", pub)
        self.assertNotIn("signature", pub)


class SimilarityTests(unittest.TestCase):
    """Whether the box has to pay twice to look at the same shot."""

    def test_identical_frames_are_the_same_shot(self) -> None:
        self.assertTrue(frames.frames_similar(_sig(120), _sig(120)))

    def test_a_genuinely_different_frame_is_not(self) -> None:
        self.assertFalse(frames.frames_similar(_sig(40), _sig(190)))

    def test_an_unknown_signature_is_never_a_match(self) -> None:
        self.assertFalse(frames.frames_similar(None, _sig()))
        self.assertFalse(frames.frames_similar(_sig(), b""))
        self.assertFalse(frames.frames_similar(_sig(), _sig()[:-1]))

    def test_a_new_object_in_a_corner_blocks_reuse(self) -> None:
        # frame-average difference is tiny; a handful of cells move a lot
        a = bytearray(_sig(100))
        b = bytearray(a)
        for k in range(10):
            b[k] = 240
        self.assertFalse(frames.frames_similar(bytes(a), bytes(b)))

    def test_grain_on_a_static_shot_still_reuses(self) -> None:
        a = bytearray(_sig(100))
        b = bytearray((100 + (k % 5) - 2) for k in range(len(a)))
        self.assertTrue(frames.frames_similar(bytes(a), bytes(b)))

    def test_repeats_chain_to_the_anchor_not_the_predecessor(self) -> None:
        # each frame drifts 2 levels from the last: 0-3 are one shot, 4 is not
        sigs = [_sig(100), _sig(101), _sig(102), _sig(103), _sig(200)]
        scenes = [frames.Scene(i, i * 10.0, i * 10.0 + 10.0,
                               frame=Path(f"{i}.jpg"), signature=s)
                  for i, s in enumerate(sigs)]
        frames.mark_repeats(scenes)
        self.assertEqual([s.repeat_of for s in scenes], [None, 0, 0, 0, None])

    def test_a_scene_without_a_picture_breaks_the_run(self) -> None:
        scenes = [frames.Scene(0, 0, 5, frame=Path("a.jpg"), signature=_sig()),
                  frames.Scene(1, 5, 10, frame=None, frame_error="x"),
                  frames.Scene(2, 10, 15, frame=Path("c.jpg"),
                               signature=_sig())]
        frames.mark_repeats(scenes)
        self.assertEqual([s.repeat_of for s in scenes], [None, None, None])

    def test_capture_marks_the_repeated_shot(self) -> None:
        with TemporaryDirectory() as td:
            fake = _FakeRun(write=Path(td),
                            stdouts=[_sig(100), _sig(100), _sig(220)])
            scenes = [frames.Scene(i, i * 10.0, i * 10.0 + 10.0)
                      for i in range(3)]
            with mock.patch.object(frames, "_run", fake):
                out = frames.capture_frames(Path("v.mp4"), scenes, Path(td))
        self.assertEqual([s.repeat_of for s in out], [None, 0, None])
        # the signature rides a second output of the SAME invocation
        self.assertEqual(len(fake.calls), 3)
        self.assertIn("rawvideo", fake.calls[0])

    def test_a_missing_signature_never_reuses(self) -> None:
        with TemporaryDirectory() as td:
            fake = _FakeRun(write=Path(td), stdouts=[b"", b""])
            scenes = [frames.Scene(0, 0.0, 10.0), frames.Scene(1, 10.0, 20.0)]
            with mock.patch.object(frames, "_run", fake):
                out = frames.capture_frames(Path("v.mp4"), scenes, Path(td))
        self.assertEqual([s.repeat_of for s in out], [None, None])
        self.assertTrue(all(s.frame is not None for s in out))


if __name__ == "__main__":
    unittest.main()
