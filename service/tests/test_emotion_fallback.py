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

    def test_voices_reuses_the_canonical_fallback_function(self) -> None:
        """The real invariant behind the agreement tests below.

        The historical bug was voices.py computing its fallback INDEPENDENTLY,
        so the manifest could advertise a different emotion than resolve() picks.
        But voices.py imports deterministic_fallback straight from emotions, and
        resolve() calls that same object — so the agreement tests compare a
        function to ITSELF and would still pass if someone reintroduced a
        separate copy in voices.py (exactly the regression they guard against).
        Assert the shared identity explicitly, which actually detects it.
        """
        import service.voices as vc
        self.assertIs(vc.deterministic_fallback, em.deterministic_fallback,
                      "voices.py must reuse the canonical emotions.deterministic_fallback, "
                      "not re-implement it (the manifest/resolve divergence bug)")

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


def _probe(f0_mean: float, f0_sd: float, energy_rms: float,
           rate_proxy: float, spectral_tilt: float) -> dict:
    """A synthetic prosody.probe result. Real audio is exercised in
    test_prosody; here the vectors are hand-placed so the GEOMETRY is what is
    under test rather than the DSP."""
    return {"f0_mean": f0_mean, "f0_sd": f0_sd, "energy_rms": energy_rms,
            "rate_proxy": rate_proxy, "spectral_tilt": spectral_tilt,
            "version": 1}


# One speaker, three measured slots: quiet/low/slow, middling, loud/high/fast.
# Nothing about the LABELS matters below — only where each take sits.
_QUIET = _probe(105.0, 8.0, 0.02, 2.0, -14.0)
_MIDDLE = _probe(150.0, 18.0, 0.10, 3.5, -9.0)
_HOT = _probe(235.0, 46.0, 0.45, 6.5, -3.0)


class ColdStartUnchangedTests(unittest.TestCase):
    """Measured mode is opt-in. Called the old way, resolve() is the old
    function — this is the guarantee every existing caller relies on."""

    def test_resolve_without_prosody_is_the_chain(self) -> None:
        avail = {"baseline": "b", "happy": "h"}
        self.assertEqual(em.resolve("excited", avail), ("h", "happy", True))
        self.assertEqual(em.resolve("excited", avail, prosody=None),
                         ("h", "happy", True))

    def test_unmeasured_rows_fall_through_to_the_chain(self) -> None:
        # prosody supplied but empty/garbage per slot: no measured space exists,
        # so the cold-start default must still apply.
        avail = {"baseline": "b", "happy": "h"}
        for junk in ({}, {"happy": None}, {"happy": {"version": 1}},
                     {"happy": {"reason": "silent", "f0_mean": None}},
                     {"happy": "not a mapping"}):
            with self.subTest(prosody=junk):
                self.assertEqual(em.resolve("excited", avail, prosody=junk),
                                 ("h", "happy", True))

    def test_a_single_measured_slot_is_not_a_space(self) -> None:
        # One point has no spread, so there is nothing to normalise against.
        avail = {"baseline": "b", "happy": "h"}
        self.assertIsNone(em.nearest_measured(
            "excited", avail, {"happy": _HOT}))
        self.assertEqual(em.resolve("excited", avail, prosody={"happy": _HOT}),
                         ("h", "happy", True))

    def test_identical_measurements_have_no_spread(self) -> None:
        avail = {"baseline": "b", "sad": "s"}
        prosody = {"baseline": _MIDDLE, "sad": dict(_MIDDLE)}
        self.assertIsNone(em.nearest_measured("excited", avail, prosody))

    def test_custom_emotion_has_no_prior_and_no_measured_opinion(self) -> None:
        # Free fallback for custom emotions needs the affect plane (M2 step 5),
        # which is NOT in this batch. Until then a custom miss keeps taking the
        # documented deterministic tail rather than a made-up guess.
        avail = {"baseline": "b", "sad": "s", "angry": "a"}
        prosody = {"baseline": _MIDDLE, "sad": _QUIET, "angry": _HOT}
        self.assertIsNone(em.nearest_measured("sarcastic", avail, prosody))
        self.assertEqual(em.resolve("sarcastic", avail, prosody=prosody),
                         ("b", "baseline", True))

    def test_direct_hit_never_consults_the_measurements(self) -> None:
        avail = {"baseline": "b", "angry": "a"}
        prosody = {"baseline": _MIDDLE, "angry": _QUIET}  # deliberately wrong
        self.assertEqual(em.resolve("angry", avail, prosody=prosody),
                         ("a", "angry", False))


class MeasuredFallbackTests(unittest.TestCase):
    """The point of the feature: the chain stops guessing where audio exists."""

    AVAIL = {"baseline": "b-id", "sad": "s-id", "angry": "a-id"}
    PROSODY = {"baseline": _MIDDLE, "sad": _QUIET, "angry": _HOT}

    def test_high_arousal_request_lands_on_the_hot_take(self) -> None:
        vid, used, fell = em.resolve("excited", self.AVAIL, prosody=self.PROSODY)
        self.assertEqual((vid, used, fell), ("a-id", "angry", True))

    def test_quiet_request_lands_on_the_quiet_take(self) -> None:
        self.assertEqual(em.nearest_measured("whisper", self.AVAIL, self.PROSODY),
                         "sad")

    def test_measurement_overrides_the_hardcoded_chain(self) -> None:
        """The `whisper` slot that was actually shouted.

        The chain says whisper -> calm -> baseline, forever, for every speaker.
        Here `calm` exists but was recorded loud and fast, while `sad` is the
        genuinely quiet take — so the measured walk picks `sad` and the chain
        picks `calm`. That divergence IS the feature.
        """
        avail = {"baseline": "b", "calm": "c", "sad": "s"}
        prosody = {"baseline": _MIDDLE, "calm": _HOT, "sad": _QUIET}
        self.assertEqual(em.resolve("whisper", avail)[1], "calm")
        self.assertEqual(em.resolve("whisper", avail, prosody=prosody)[1], "sad")

    def test_slots_without_a_measurement_are_not_candidates(self) -> None:
        # `angry` is the acoustic answer for `excited`, but it has no probe —
        # measured mode may only choose from what it has actually heard.
        avail = dict(self.AVAIL)
        prosody = {"baseline": _MIDDLE, "sad": _QUIET}
        self.assertEqual(
            em.nearest_measured("excited", avail, prosody), "baseline")

    def test_result_is_independent_of_mapping_order(self) -> None:
        forward = em.resolve("excited", self.AVAIL, prosody=self.PROSODY)
        rev_avail = dict(reversed(list(self.AVAIL.items())))
        rev_prosody = dict(reversed(list(self.PROSODY.items())))
        self.assertEqual(em.resolve("excited", rev_avail, prosody=rev_prosody),
                         forward)

    def test_repeated_calls_agree(self) -> None:
        first = em.resolve("excited", self.AVAIL, prosody=self.PROSODY)
        for _ in range(5):
            self.assertEqual(em.resolve("excited", self.AVAIL,
                                        prosody=self.PROSODY), first)

    def test_ties_break_on_scale_order_then_name(self) -> None:
        # Two slots at the same distance from the prior: the tie-break is the
        # same ordering deterministic_fallback uses, so resolve and the manifest
        # can never disagree about which of two equals wins.
        avail = {"sad": "s", "happy": "h", "confused": "c"}
        prosody = {"sad": _QUIET, "happy": _HOT, "confused": _HOT}
        # happy and confused are the SAME point; happy precedes confused on the
        # scale, so happy must win regardless of insertion order.
        self.assertEqual(em.nearest_measured("excited", avail, prosody), "happy")
        rev = {"confused": _HOT, "happy": _HOT, "sad": _QUIET}
        self.assertEqual(em.nearest_measured("excited", avail, rev), "happy")

    def test_fell_back_semantics_are_preserved(self) -> None:
        # app.py records demand off this flag; measured mode must not quietly
        # start reporting a fallback as a hit.
        _vid, used, fell = em.resolve("excited", self.AVAIL, prosody=self.PROSODY)
        self.assertTrue(fell)
        self.assertNotEqual(used, "excited")

    def test_partially_measured_slots_still_participate(self) -> None:
        # A whisper take with no recoverable f0 keeps its energy/rate/tilt.
        partial = {"f0_mean": None, "f0_sd": None, "energy_rms": 0.02,
                   "rate_proxy": 2.0, "spectral_tilt": -14.0,
                   "version": 1, "reason": "unvoiced"}
        avail = {"baseline": "b", "sad": "s"}
        prosody = {"baseline": _HOT, "sad": partial}
        self.assertEqual(em.nearest_measured("whisper", avail, prosody), "sad")

    def test_every_expressive_slot_has_a_prior(self) -> None:
        # A missing entry silently disables measured mode for that slot, so the
        # coverage is asserted rather than assumed. `baseline` is excluded on
        # purpose: it is the ORIGIN of this space, not a direction in it.
        self.assertEqual(set(em.EMOTION_PROSODY_PRIOR),
                         set(em.EMOTION_SCALE) - {em.BASELINE})
        for emotion, prior in em.EMOTION_PROSODY_PRIOR.items():
            with self.subTest(emotion=emotion):
                self.assertTrue(prior, emotion)
                self.assertTrue(set(prior) <= set(em.PROSODY_FIELDS))
                self.assertTrue(any(v for v in prior.values()),
                                "a prior of all zeros points nowhere")

    def test_a_missed_baseline_request_keeps_the_deterministic_tail(self) -> None:
        # baseline is mandatory, so this is an edge case — but it must not be
        # answered by pointing at a direction baseline doesn't have.
        avail = {"sad": "s", "angry": "a"}
        prosody = {"sad": _QUIET, "angry": _HOT}
        self.assertIsNone(em.nearest_measured("baseline", avail, prosody))
        self.assertEqual(em.resolve("baseline", avail, prosody=prosody),
                         ("s", "sad", True))  # scale-first pick: sad precedes angry


class ProsodyVectorTests(unittest.TestCase):
    def test_energy_is_compared_on_a_log_scale(self) -> None:
        # Linear RMS would let one loud take dominate the whole space.
        quiet = em.prosody_vector({"energy_rms": 0.01})
        loud = em.prosody_vector({"energy_rms": 0.1})
        self.assertAlmostEqual(loud["energy_rms"] - quiet["energy_rms"], 20.0,
                               places=6)

    def test_unmeasured_and_nonsense_fields_are_dropped(self) -> None:
        self.assertIsNone(em.prosody_vector(None))
        self.assertIsNone(em.prosody_vector("nope"))
        self.assertIsNone(em.prosody_vector({"version": 1}))
        self.assertIsNone(em.prosody_vector({"energy_rms": 0.0}))  # log undefined
        self.assertIsNone(em.prosody_vector({"f0_mean": float("nan")}))
        self.assertIsNone(em.prosody_vector({"f0_mean": True}))  # bool is not a level
        self.assertEqual(list(em.prosody_vector({"f0_mean": 120.0,
                                                 "f0_sd": None})), ["f0_mean"])


class LabelCheckTests(unittest.TestCase):
    """Advisory only: it may be silent, it may be wrong, it may never block."""

    def test_a_shouted_whisper_does_not_agree(self) -> None:
        out = em.label_check(_HOT, "whisper",
                             [{"emotion": "baseline", "prosody": _QUIET}])
        self.assertIsNotNone(out)
        self.assertEqual(set(out), {"agrees", "nearest", "distance"})
        self.assertFalse(out["agrees"])

    def test_a_consistent_take_agrees(self) -> None:
        rows = [{"emotion": "baseline", "prosody": _MIDDLE},
                {"emotion": "whisper", "prosody": _QUIET}]
        # A second take that sits right on the existing `whisper` exemplar.
        near_quiet = _probe(107.0, 9.0, 0.021, 2.1, -13.5)
        out = em.label_check(near_quiet, "whisper", rows)
        self.assertTrue(out["agrees"])
        self.assertEqual(out["nearest"], "whisper")

    def test_silence_when_there_is_nothing_to_compare_against(self) -> None:
        # First voice of a brand-new Character: no space, so no opinion. Per the
        # batch design's "absent = invisible", the caller renders nothing.
        self.assertIsNone(em.label_check(_HOT, "angry", []))
        self.assertIsNone(em.label_check(_HOT, "angry", None))
        self.assertIsNone(em.label_check(
            _HOT, "angry", [{"emotion": "baseline"}]))

    def test_silence_for_an_unmeasurable_take(self) -> None:
        rows = [{"emotion": "baseline", "prosody": _MIDDLE}]
        for junk in (None, {}, {"reason": "silent", "f0_mean": None}):
            with self.subTest(take=junk):
                self.assertIsNone(em.label_check(junk, "angry", rows))

    def test_silence_when_the_declared_label_has_no_anchor(self) -> None:
        # A custom emotion the Character has never recorded: "agrees" would be
        # meaningless, so nothing is claimed.
        rows = [{"emotion": "baseline", "prosody": _MIDDLE}]
        self.assertIsNone(em.label_check(_HOT, "sarcastic", rows))
        # ...but once it HAS a measured exemplar, the check works for it.
        rows.append({"emotion": "sarcastic", "prosody": _HOT})
        out = em.label_check(_HOT, "sarcastic", rows)
        self.assertIsNotNone(out)
        self.assertTrue(out["agrees"])

    def test_malformed_rows_are_ignored_not_fatal(self) -> None:
        rows = ["nonsense", None, {"prosody": _QUIET},          # no emotion
                {"emotion": "", "prosody": _QUIET},             # empty emotion
                {"emotion": "baseline", "prosody": "junk"},     # no vector
                {"emotion": "whisper", "prosody": _QUIET}]      # the only usable row
        out = em.label_check(_HOT, "whisper", rows)
        self.assertIsNotNone(out)
        self.assertFalse(out["agrees"])

    def test_result_is_independent_of_row_order(self) -> None:
        rows = [{"emotion": "baseline", "prosody": _MIDDLE},
                {"emotion": "whisper", "prosody": _QUIET},
                {"emotion": "whisper", "prosody": _probe(112.0, 7.0, 0.03, 2.2, -13.0)}]
        first = em.label_check(_HOT, "angry", rows)
        self.assertEqual(em.label_check(_HOT, "angry", list(reversed(rows))), first,
                         "duplicate takes of one slot average; order must not count")

    def test_distance_is_a_plain_rounded_float(self) -> None:
        out = em.label_check(_HOT, "whisper",
                             [{"emotion": "baseline", "prosody": _QUIET}])
        self.assertIsInstance(out["distance"], float)
        self.assertGreaterEqual(out["distance"], 0.0)
        self.assertEqual(out["distance"], round(out["distance"], 4))


if __name__ == "__main__":
    unittest.main()
