"""The fit ladder — the heart of re-voicing. Every rung is pinned: verbatim,
atempo, rewrite, rewrite+atempo, spill — and the report must name which one
ran. atempo itself is tested through the `_run` seam (no real ffmpeg).
"""
from __future__ import annotations

import io
import unittest
import wave
from unittest import mock

import numpy as np

from service import revoice


def _wav(seconds: float, rate: int = 24000) -> bytes:
    pcm = (np.ones(int(seconds * rate)) * 0.2 * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _speak_of(*durations: float):
    """A speak seam whose Nth call answers the Nth duration."""
    seq = list(durations)

    def speak(text):
        d = seq.pop(0)
        return _wav(d), d
    return speak


def _fake_atempo(wav_bytes: bytes, factor: float) -> bytes:
    return _wav(revoice.wav_seconds(wav_bytes) / factor)


class FitLadderTests(unittest.TestCase):
    def test_a_fitting_line_is_verbatim(self) -> None:
        out = revoice.fit_line("hi", 5.0, speak=_speak_of(4.8))
        self.assertEqual(out["method"], "verbatim")
        self.assertIsNone(out["atempo"])
        self.assertEqual(out["spill_seconds"], 0.0)

    def test_tolerance_is_a_fit_not_a_stretch(self) -> None:
        out = revoice.fit_line("hi", 5.0, speak=_speak_of(5.2))  # 4% over
        self.assertEqual(out["method"], "verbatim")

    def test_a_slightly_long_line_is_atempod_within_the_cap(self) -> None:
        with mock.patch.object(revoice, "atempo", _fake_atempo):
            out = revoice.fit_line("hi", 5.0, speak=_speak_of(5.35))
        self.assertEqual(out["method"], "atempo")
        self.assertAlmostEqual(out["atempo"], 1.07, places=2)
        self.assertLessEqual(out["seconds"], 5.0 * 1.01 + 0.01)

    def test_a_much_longer_line_is_rewritten_then_fits(self) -> None:
        rewrites = []

        def rewrite(text, max_words):
            rewrites.append((text, max_words))
            return "shorter line"

        with mock.patch.object(revoice, "atempo", _fake_atempo):
            out = revoice.fit_line("a very long line", 5.0,
                                   speak=_speak_of(8.0, 4.6),
                                   rewrite=rewrite)
        self.assertEqual(out["method"], "rewrite")
        self.assertEqual(out["rewritten_text"], "shorter line")
        self.assertEqual(rewrites[0][1], int(5.0 * 2.8))

    def test_a_rewrite_still_long_gets_atempo_on_top(self) -> None:
        with mock.patch.object(revoice, "atempo", _fake_atempo):
            out = revoice.fit_line("long", 5.0, speak=_speak_of(8.0, 5.4),
                                   rewrite=lambda t, w: "shorter")
        self.assertEqual(out["method"], "rewrite+atempo")
        self.assertIsNotNone(out["atempo"])

    def test_no_rewriter_means_an_honest_spill(self) -> None:
        out = revoice.fit_line("long", 5.0, speak=_speak_of(8.0))
        self.assertEqual(out["method"], "spill")
        self.assertAlmostEqual(out["spill_seconds"], 3.0, places=1)

    def test_a_failed_rewrite_keeps_the_smaller_spill(self) -> None:
        # rewrite comes back LONGER than the original — keep the original
        with mock.patch.object(revoice, "atempo",
                               side_effect=revoice.RevoiceError("no")):
            out = revoice.fit_line("long", 5.0, speak=_speak_of(6.0, 7.5),
                                   rewrite=lambda t, w: "somehow longer")
        self.assertEqual(out["method"], "spill")
        self.assertAlmostEqual(out["seconds"], 6.0, places=1)

    def test_a_broken_brain_degrades_to_spill_not_a_crash(self) -> None:
        def bad_rewrite(text, max_words):
            raise RuntimeError("brain down")

        out = revoice.fit_line("long", 5.0, speak=_speak_of(8.0),
                               rewrite=bad_rewrite)
        self.assertEqual(out["method"], "spill")


class AtempoSeamTests(unittest.TestCase):
    def test_sanity_bounds_are_enforced_before_ffmpeg(self) -> None:
        for bad in (0.4, 2.5):
            with self.subTest(factor=bad), \
                    self.assertRaises(revoice.RevoiceError):
                revoice.atempo(b"RIFF", bad)

    def test_a_refusing_ffmpeg_is_named_not_leaked(self) -> None:
        r = type("R", (), {"returncode": 1, "stdout": b"",
                           "stderr": b"/etc/shadow oops"})()
        with mock.patch.object(revoice, "_run", return_value=r):
            with self.assertRaises(revoice.RevoiceError) as ctx:
                revoice.atempo(_wav(1.0), 1.05)
        self.assertNotIn("shadow", str(ctx.exception))


class DirectionTests(unittest.TestCase):
    LINES = [{"i": 0, "character_id": "ada", "text": "I can't believe it!"},
             {"i": 1, "character_id": "bo", "text": "Calm down."}]
    EMO = {"ada": ["baseline", "excited"], "bo": ["baseline"]}

    def test_the_plan_lands_by_index_within_each_characters_stems(self) -> None:
        revoice.apply_direction(self.LINES, {"lines": [
            {"i": 0, "emotion": "excited"}, {"i": 1, "emotion": "excited"}]},
            self.EMO)
        self.assertEqual(self.LINES[0]["emotion"], "excited")
        # bo has no excited stem — falls to baseline, visibly
        self.assertEqual(self.LINES[1]["emotion"], "baseline")
        self.assertEqual(self.LINES[1]["emotion_requested"], "excited")

    def test_the_prompt_offers_only_each_lines_own_stems(self) -> None:
        p = revoice.direction_prompt(self.LINES, self.EMO)
        self.assertIn("baseline, excited", p)
        self.assertIn("ONE emotion", p)


if __name__ == "__main__":
    unittest.main()
