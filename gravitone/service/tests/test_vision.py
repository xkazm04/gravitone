"""The Qwen vision seam — alignment, key gating and batch degradation.
No test here reaches the network: `_post` is patched, and the one test of
`_post` itself patches `urllib.request.urlopen`.
"""
from __future__ import annotations

import io
import json
import unittest
import urllib.error
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service import vision


def _body(scenes: list[dict]) -> dict:
    return {"choices": [{"message": {
        "content": json.dumps({"scenes": scenes})}}]}


class AlignTests(unittest.TestCase):
    def test_members_land_by_declared_index_not_position(self) -> None:
        out = vision._align(_body([
            {"index": 2, "caption": "b"}, {"index": 0, "caption": "a"}]),
            [0, 2])
        self.assertEqual(out[0]["caption"], "a")
        self.assertEqual(out[1]["caption"], "b")

    def test_a_scene_the_model_skipped_is_none_not_shifted(self) -> None:
        out = vision._align(_body([{"index": 5, "caption": "x"}]), [4, 5, 6])
        self.assertEqual([o is None for o in out], [True, False, True])

    def test_an_unparseable_answer_raises_a_named_error(self) -> None:
        with self.assertRaises(vision.VisionError):
            vision._align({"choices": [{"message": {"content": "not json"}}]},
                          [0])

    def test_speaker_on_screen_is_bool_or_none_never_a_string(self) -> None:
        out = vision._align(_body([
            {"index": 0, "speaker_on_screen": "yes"},
            {"index": 1, "speaker_on_screen": True}]), [0, 1])
        self.assertIsNone(out[0]["speaker_on_screen"])
        self.assertIs(out[1]["speaker_on_screen"], True)


class GatingTests(unittest.TestCase):
    def test_no_key_means_no_call_and_a_named_refusal(self) -> None:
        with mock.patch.dict("os.environ",
                             {"QWEN_API_KEY": "", "DASHSCOPE_API_KEY": ""}):
            self.assertFalse(vision.available())
            with self.assertRaises(vision.VisionError):
                vision.describe_scenes([{"i": 0, "frame": "x.jpg"}])

    def test_a_scene_without_a_frame_costs_no_call(self) -> None:
        posted = []
        with mock.patch.dict("os.environ", {"QWEN_API_KEY": "sk-test"}), \
                mock.patch.object(vision, "_post",
                                  side_effect=lambda *a, **k: posted.append(1)):
            out = vision.describe_scenes([{"i": 0, "frame": None},
                                          {"i": 1}])
        self.assertEqual(out, [None, None])
        self.assertEqual(posted, [])


class DegradeTests(unittest.TestCase):
    def test_one_failed_batch_does_not_cost_the_others(self) -> None:
        with TemporaryDirectory() as td:
            frames = []
            for i in range(2):
                p = Path(td) / f"f{i}.jpg"
                p.write_bytes(b"\xff\xd8")
                frames.append({"i": i, "start": 0, "end": 5, "frame": str(p)})
            calls = {"n": 0}

            def flaky(scenes, *, context, spend):
                calls["n"] += 1
                if calls["n"] == 1:
                    raise vision.VisionError("boom")
                return [{"caption": "ok", "model": "m"}]

            with mock.patch.dict("os.environ", {"QWEN_API_KEY": "sk-test"}), \
                    mock.patch.object(vision, "BATCH", 1), \
                    mock.patch.object(vision, "_describe_batch", flaky):
                out = vision.describe_scenes(frames)
        self.assertIsNone(out[0])
        self.assertEqual(out[1]["caption"], "ok")


class PostTests(unittest.TestCase):
    def test_429_retries_then_succeeds(self) -> None:
        good = io.BytesIO(json.dumps(_body([])).encode())
        good.read1 = good.read  # urlopen context manager compat
        answers = [
            urllib.error.HTTPError("u", 429, "busy", None, io.BytesIO(b"slow")),
            mock.MagicMock(__enter__=lambda s: io.BytesIO(
                json.dumps(_body([])).encode()), __exit__=lambda *a: False),
        ]

        def fake_urlopen(req, timeout=None):
            a = answers.pop(0)
            if isinstance(a, Exception):
                raise a
            return a

        with mock.patch.dict("os.environ", {"QWEN_API_KEY": "sk-test"}), \
                mock.patch("urllib.request.urlopen", fake_urlopen), \
                mock.patch("time.sleep"):
            body = vision._post({"model": "m"}, spend=None)
        self.assertIn("choices", body)

    def test_a_permanent_400_never_retries(self) -> None:
        calls = {"n": 0}

        def fake_urlopen(req, timeout=None):
            calls["n"] += 1
            raise urllib.error.HTTPError("u", 400, "bad", None,
                                         io.BytesIO(b"bad request"))

        with mock.patch.dict("os.environ", {"QWEN_API_KEY": "sk-test"}), \
                mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(vision.VisionError) as ctx:
                vision._post({"model": "m"}, spend=None)
        self.assertEqual(calls["n"], 1)
        self.assertIn("400", str(ctx.exception))
        self.assertNotIn("bad request", str(ctx.exception))   # body stays logged


if __name__ == "__main__":
    unittest.main()
