"""Direction 3 — nearest-emotion fallback.

A miss used to collapse flat to baseline ([excited] on a happy-only Character
read neutral), and a Character with no baseline picked a voice by arbitrary dict
order — which the manifest computed independently, so the two could disagree.

resolve() now walks requested -> adjacent emotions (FALLBACK_CHAIN) -> baseline
-> a deterministic scale-first voice, reporting the TRUE emotion used. The same
deterministic pick backs the manifest, so they always agree. Requested-emotion
telemetry (fell_back semantics) is preserved.
"""
from __future__ import annotations

import unittest

from service import emotions as em


class NearestEmotionTests(unittest.TestCase):
    def test_direct_hit_never_falls_back(self) -> None:
        avail = {"baseline": "b", "excited": "e"}
        self.assertEqual(em.resolve("excited", avail), ("e", "excited", False))

    def test_excited_falls_to_happy_when_happy_exists(self) -> None:
        # happy-only Character asked for excited -> reads happy, not neutral.
        avail = {"baseline": "b", "happy": "h"}
        self.assertEqual(em.resolve("excited", avail), ("h", "happy", True))

    def test_happy_falls_to_excited(self) -> None:
        avail = {"baseline": "b", "excited": "e"}
        self.assertEqual(em.resolve("happy", avail), ("e", "excited", True))

    def test_angry_chain_uses_excited_then_baseline(self) -> None:
        # angry -> excited (present) -> excited wins.
        with_excited = {"baseline": "b", "excited": "e"}
        self.assertEqual(em.resolve("angry", with_excited), ("e", "excited", True))
        # angry -> excited (absent) -> baseline.
        only_baseline = {"baseline": "b"}
        self.assertEqual(em.resolve("angry", only_baseline), ("b", "baseline", True))

    def test_whisper_and_confused_prefer_calm(self) -> None:
        avail = {"baseline": "b", "calm": "c"}
        self.assertEqual(em.resolve("whisper", avail), ("c", "calm", True))
        self.assertEqual(em.resolve("confused", avail), ("c", "calm", True))

    def test_custom_emotion_with_no_chain_falls_to_baseline(self) -> None:
        avail = {"baseline": "b", "happy": "h"}
        self.assertEqual(em.resolve("sarcastic", avail), ("b", "baseline", True))


class DeterministicNoBaselineTests(unittest.TestCase):
    def test_no_baseline_picks_scale_first_deterministically(self) -> None:
        # No baseline, no adjacency hit: earliest slot in EMOTION_SCALE wins.
        # (calm precedes happy/sad on the scale.) Dict order must not matter.
        avail = {"sad": "s", "happy": "h", "calm": "c"}
        vid, used, fell = em.resolve("angry", avail)
        self.assertEqual((vid, used, fell), ("c", "calm", True))
        # Reversed insertion order -> identical result (no dict-order dependence).
        rev = {"happy": "h", "sad": "s", "calm": "c"}
        self.assertEqual(em.resolve("angry", rev), ("c", "calm", True))

    def test_custom_only_falls_back_alphabetically(self) -> None:
        # Only non-scale emotions present: sort by (last, then name).
        avail = {"zesty": "z", "asmr": "a"}
        self.assertEqual(em.deterministic_fallback(avail), "asmr")

    def test_deterministic_fallback_prefers_baseline(self) -> None:
        self.assertEqual(
            em.deterministic_fallback({"happy": "h", "baseline": "b"}), "baseline")

    def test_empty_available_returns_none(self) -> None:
        self.assertIsNone(em.deterministic_fallback({}))


class TelemetrySemanticsTests(unittest.TestCase):
    def test_fell_back_true_iff_used_differs_from_requested(self) -> None:
        # This is exactly the flag app.py uses to decide record_fallback(requested).
        cases = [
            ("excited", {"baseline": "b", "excited": "e"}, False),  # hit
            ("excited", {"baseline": "b", "happy": "h"}, True),     # -> happy
            ("angry", {"baseline": "b"}, True),                     # -> baseline
        ]
        for requested, avail, expect_fell in cases:
            _vid, used, fell = em.resolve(requested, avail)
            self.assertEqual(fell, used != requested, f"{requested} in {avail}")
            self.assertEqual(fell, expect_fell)


class ManifestAgreementTests(unittest.TestCase):
    """The manifest's advertised fallback must be what resolve would actually
    choose for an unmatchable request — same deterministic function."""

    def _manifest_fallback(self, native_emotions):
        import service.voices as vc
        native = {e: {"voice_id": f"{e}-id"} for e in native_emotions}
        return vc.deterministic_fallback(native)

    def test_manifest_agrees_with_resolve_no_baseline(self) -> None:
        native = ["sad", "happy", "calm"]
        manifest_fb = self._manifest_fallback(native)
        avail = {e: f"{e}-id" for e in native}
        # An unmatchable custom request resolves to the same emotion the
        # manifest advertises.
        _vid, used, _fell = em.resolve("no_such_emotion", avail)
        self.assertEqual(manifest_fb, used)
        self.assertEqual(used, "calm")

    def test_manifest_agrees_with_resolve_with_baseline(self) -> None:
        native = ["baseline", "happy"]
        manifest_fb = self._manifest_fallback(native)
        avail = {e: f"{e}-id" for e in native}
        _vid, used, _fell = em.resolve("no_such_emotion", avail)
        self.assertEqual(manifest_fb, used)
        self.assertEqual(used, "baseline")


if __name__ == "__main__":
    unittest.main()
