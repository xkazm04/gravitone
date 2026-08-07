"""The text brain seam — parsing, self-repair, backend selection. Nothing
here spawns the CLI or reaches a network; the OpenAI-compat test patches
`urllib.request.urlopen`.
"""
from __future__ import annotations

import io
import json
import unittest
import urllib.error
from unittest import mock

from service import brain


class ParseJsonTests(unittest.TestCase):
    def test_code_fences_and_prose_are_stripped(self) -> None:
        raw = "Sure! Here is the plan:\n```json\n{\"a\": 1}\n```\nHope it helps."
        self.assertEqual(brain._parse_json(raw), {"a": 1})

    def test_a_bare_object_parses(self) -> None:
        self.assertEqual(brain._parse_json('{"x": [1, 2]}'), {"x": [1, 2]})

    def test_no_object_is_a_value_error(self) -> None:
        for bad in ("", "plain prose", "[1, 2, 3]"):
            with self.subTest(raw=bad), self.assertRaises(ValueError):
                brain._parse_json(bad)


class _Scripted(brain.Brain):
    name = "scripted-test"

    def __init__(self, answers: list[str]) -> None:
        self.answers = list(answers)
        self.prompts: list[str] = []

    def complete(self, prompt, *, system="", temperature=0.4, max_tokens=None):
        self.prompts.append(prompt)
        return self.answers.pop(0)


class CompleteJsonTests(unittest.TestCase):
    def test_a_malformed_first_answer_is_repaired_once(self) -> None:
        b = _Scripted(["not json at all", '{"ok": true}'])
        self.assertEqual(b.complete_json("plan"), {"ok": True})
        self.assertEqual(len(b.prompts), 2)
        self.assertIn("could not be parsed", b.prompts[1])

    def test_two_malformed_answers_are_a_named_error(self) -> None:
        b = _Scripted(["nope", "still nope"])
        with self.assertRaises(brain.BrainError):
            b.complete_json("plan")


class MakeBrainTests(unittest.TestCase):
    def test_unknown_kind_is_refused_with_the_menu(self) -> None:
        with self.assertRaises(brain.BrainError) as ctx:
            brain.make_brain("telepathy")
        self.assertIn("claude-cli", str(ctx.exception))

    def test_a_preset_without_its_key_names_the_variable(self) -> None:
        with mock.patch.dict("os.environ", {"OPENAI_API_KEY": ""}):
            with self.assertRaises(brain.BrainError) as ctx:
                brain.make_brain("openai")
        self.assertIn("OPENAI_API_KEY", str(ctx.exception))

    def test_the_qwen_preset_uses_the_dashscope_endpoint(self) -> None:
        with mock.patch.dict("os.environ", {"QWEN_API_KEY": "sk-test",
                                            "BRAIN_MODEL": ""}):
            b = brain.make_brain("qwen")
        self.assertIn("dashscope", b.describe()["base_url"])
        self.assertEqual(b.describe()["model"], "qwen3.8-max")
        self.assertEqual(b.describe()["backend"], "qwen")

    def test_openai_compat_requires_an_explicit_base_url(self) -> None:
        with mock.patch.dict("os.environ", {"BRAIN_BASE_URL": ""}):
            with self.assertRaises(brain.BrainError):
                brain.make_brain("openai-compat")


class OpenAiCompatTests(unittest.TestCase):
    def _answer(self, text: str) -> mock.MagicMock:
        body = json.dumps(
            {"choices": [{"message": {"content": text}}]}).encode()
        return mock.MagicMock(__enter__=lambda s: io.BytesIO(body),
                              __exit__=lambda *a: False)

    def test_the_content_comes_back_verbatim(self) -> None:
        b = brain.OpenAiCompatBrain("http://box:1234/v1", "m")
        with mock.patch("urllib.request.urlopen",
                        return_value=self._answer("  hello  ")):
            self.assertEqual(b.complete("hi"), "  hello  ")

    def test_a_permanent_4xx_never_retries_and_stays_clean(self) -> None:
        calls = {"n": 0}

        def fake(req, timeout=None):
            calls["n"] += 1
            raise urllib.error.HTTPError("u", 401, "no", None,
                                         io.BytesIO(b"secret-key-echo"))

        b = brain.OpenAiCompatBrain("http://box:1234/v1", "m", "k")
        with mock.patch("urllib.request.urlopen", fake):
            with self.assertRaises(brain.BrainError) as ctx:
                b.complete("hi")
        self.assertEqual(calls["n"], 1)
        self.assertNotIn("secret-key-echo", str(ctx.exception))

    def test_transport_failures_retry_against_the_budget(self) -> None:
        calls = {"n": 0}

        def fake(req, timeout=None):
            calls["n"] += 1
            raise urllib.error.URLError("down")

        b = brain.OpenAiCompatBrain("http://box:1234/v1", "m")
        with mock.patch("urllib.request.urlopen", fake), \
                mock.patch("time.sleep"):
            with self.assertRaises(brain.BrainError):
                b.complete("hi")
        self.assertEqual(calls["n"], brain.RETRY_ATTEMPTS + 1)


if __name__ == "__main__":
    unittest.main()
