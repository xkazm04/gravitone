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


class RepairTests(unittest.TestCase):
    """A malformed answer is quoted back once, brain.complete_json's shape."""

    @staticmethod
    def _scenes(td: str, n: int) -> list[dict]:
        out = []
        for i in range(n):
            p = Path(td) / f"f{i}.jpg"
            p.write_bytes(b"\xff\xd8")
            out.append({"i": i, "start": 0, "end": 5, "frame": str(p)})
        return out

    def test_a_malformed_answer_is_repaired_on_the_second_ask(self) -> None:
        posts: list[dict] = []

        def fake_post(payload, *, spend):
            posts.append(payload)
            if len(posts) == 1:
                return {"choices": [{"message": {"content": "sure! {oops"}}]}
            return _body([{"index": 0, "caption": "a room"}])

        with TemporaryDirectory() as td, \
                mock.patch.dict("os.environ", {"QWEN_API_KEY": "sk-test"}), \
                mock.patch.object(vision, "_post", fake_post):
            scenes = self._scenes(td, 1)
            out = vision.describe_scenes(scenes)
        self.assertEqual(len(posts), 2)
        self.assertEqual(out[0]["caption"], "a room")
        self.assertEqual(scenes[0]["description_status"], vision.DESCRIBED)
        # the repair turn quotes the parse failure back and stops guessing
        repair = posts[1]["messages"][-1]["content"][0]["text"]
        self.assertIn("could not be parsed", repair)
        self.assertIn("valid JSON", repair)
        self.assertEqual(posts[1]["temperature"], 0.0)

    def test_two_malformed_answers_degrade_the_batch_and_name_why(self) -> None:
        posts = {"n": 0}

        def fake_post(payload, *, spend):
            posts["n"] += 1
            return {"choices": [{"message": {"content": "still not json"}}]}

        with TemporaryDirectory() as td, \
                mock.patch.dict("os.environ", {"QWEN_API_KEY": "sk-test"}), \
                mock.patch.object(vision, "_post", fake_post):
            scenes = self._scenes(td, 2)
            out = vision.describe_scenes(scenes)
        self.assertEqual(posts["n"], 2)              # exactly one repair, no loop
        self.assertEqual(out, [None, None])          # degraded, not raised
        self.assertEqual([s["description_status"] for s in scenes],
                         [vision.UNREADABLE, vision.UNREADABLE])

    def test_never_asked_and_unreadable_are_different_facts(self) -> None:
        def fake_post(payload, *, spend):
            return {"choices": [{"message": {"content": "nope"}}]}

        with TemporaryDirectory() as td, \
                mock.patch.dict("os.environ", {"QWEN_API_KEY": "sk-test"}), \
                mock.patch.object(vision, "_post", fake_post):
            scenes = self._scenes(td, 1) + [{"i": 1, "frame": None}]
            vision.describe_scenes(scenes)
        self.assertEqual(scenes[0]["description_status"], vision.UNREADABLE)
        self.assertEqual(scenes[1]["description_status"], vision.NO_FRAME)
        self.assertNotIn(scenes[0]["description_status"], vision.NEVER_ASKED)
        self.assertIn(scenes[1]["description_status"], vision.NEVER_ASKED)

    def test_a_scene_the_model_omitted_is_not_a_scene_it_never_saw(self) -> None:
        def fake_post(payload, *, spend):
            return _body([{"index": 0, "caption": "a"}])   # scene 1 missing

        with TemporaryDirectory() as td, \
                mock.patch.dict("os.environ", {"QWEN_API_KEY": "sk-test"}), \
                mock.patch.object(vision, "_post", fake_post):
            scenes = self._scenes(td, 2)
            out = vision.describe_scenes(scenes)
        # the surviving member still lands by its DECLARED index
        self.assertEqual(out[0]["caption"], "a")
        self.assertIsNone(out[1])
        self.assertEqual([s["description_status"] for s in scenes],
                         [vision.DESCRIBED, vision.OMITTED])

    def test_cancelling_marks_the_rest_as_never_asked(self) -> None:
        with TemporaryDirectory() as td, \
                mock.patch.dict("os.environ", {"QWEN_API_KEY": "sk-test"}), \
                mock.patch.object(vision, "BATCH", 1), \
                mock.patch.object(vision, "_post",
                                  lambda p, *, spend: _body(
                                      [{"index": 0, "caption": "a"}])):
            scenes = self._scenes(td, 3)
            seen = {"n": 0}

            def cancel_after_one() -> bool:
                seen["n"] += 1
                return seen["n"] > 1

            vision.describe_scenes(scenes, should_cancel=cancel_after_one)
        self.assertEqual([s["description_status"] for s in scenes],
                         [vision.DESCRIBED, vision.CANCELLED, vision.CANCELLED])


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
