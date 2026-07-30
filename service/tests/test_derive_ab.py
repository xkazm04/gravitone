"""The blind A/B harness: the math, the blinding, and what it publishes.

Nothing here can make a sound -- the engine needs torch and pocket_tts, absent
outside the container -- so the ONE seam that needs a model (`measure_fn`:
synthesize a line and probe it) is stubbed, and everything above it is proven
against prosody vectors this file CHOSE:

  * distance is in noticeable steps, per field, and is unmeasurable (None, not
    zero) when the two probes share too little;
  * quality is 1.0 when the derived render is no further from the target than
    the real one, and falls off with EXCESS distance -- so a real render that
    happens to sit on top of its own stored probe cannot force every derived
    voice to score zero (which the obvious ratio formula would);
  * the comparison is genuinely blind: swapping which arm is called A cannot
    change the answer;
  * the published number is a MEDIAN across speakers, carries how many speakers
    it saw, and says how many of them also built the direction it tested;
  * a box with no engine writes NOTHING and names why.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import numpy as np

from service import emotion_basis as eb
from service.tools import derive_ab as ab
from service.tests.test_emotion_basis import _SeamCase, fake_load
from service.tests.test_emotion_residuals import COHERENT, DIM


def probe(**fields) -> dict:
    """A prosody.probe-shaped result: named fields, everything else absent."""
    out: dict = {f: None for f in ("f0_mean", "f0_sd", "energy_rms",
                                   "rate_proxy", "spectral_tilt")}
    out.update(fields)
    out["version"] = 1
    return out


# energy is converted to dB by emotions.prosody_vector, so these are chosen to
# land on round dB values: 0.1 -> -20 dB, 0.05 -> ~-26 dB.
TARGET = probe(f0_mean=200.0, f0_sd=30.0, energy_rms=0.1, rate_proxy=4.0,
               spectral_tilt=-10.0)


class DistanceTests(unittest.TestCase):
    def test_identical_probes_are_zero_steps_apart(self) -> None:
        self.assertEqual(ab.distance(TARGET, dict(TARGET)), 0.0)

    def test_one_step_in_one_field_of_five_is_a_fifth_of_the_variance(self) -> None:
        # RMS, not sum: one field 20 Hz (= one step) off out of five shared
        # fields -> sqrt(1/5).
        other = probe(f0_mean=220.0, f0_sd=30.0, energy_rms=0.1, rate_proxy=4.0,
                      spectral_tilt=-10.0)
        self.assertAlmostEqual(ab.distance(TARGET, other), (1.0 / 5.0) ** 0.5,
                               places=6)

    def test_the_answer_is_per_field_so_thin_pairs_stay_comparable(self) -> None:
        # Two shared fields, one of them a full step off -> sqrt(1/2), NOT a
        # smaller number just because fewer features were measurable.
        a = probe(f0_mean=200.0, rate_proxy=4.0)
        b = probe(f0_mean=220.0, rate_proxy=4.0)
        self.assertAlmostEqual(ab.distance(a, b), (1.0 / 2.0) ** 0.5, places=6)

    def test_too_few_shared_fields_is_unmeasured_not_zero(self) -> None:
        self.assertIsNone(ab.distance(probe(f0_mean=200.0), probe(f0_mean=200.0)))

    def test_a_probe_that_measured_nothing_is_unmeasured(self) -> None:
        self.assertIsNone(ab.distance(TARGET, probe()))
        self.assertIsNone(ab.distance(TARGET, "not a probe"))

    def test_it_is_symmetric(self) -> None:
        other = probe(f0_mean=260.0, f0_sd=10.0, energy_rms=0.05, rate_proxy=6.0,
                      spectral_tilt=-4.0)
        self.assertEqual(ab.distance(TARGET, other), ab.distance(other, TARGET))


class QualityTests(unittest.TestCase):
    def test_as_close_as_the_recording_is_a_perfect_one(self) -> None:
        self.assertEqual(ab.quality(1.4, 1.4), 1.0)

    def test_closer_than_the_recording_does_not_score_above_one(self) -> None:
        self.assertEqual(ab.quality(2.0, 0.5), 1.0)

    def test_one_step_further_is_a_half(self) -> None:
        self.assertEqual(ab.quality(1.0, 2.0), 0.5)

    def test_a_perfect_real_render_cannot_condemn_every_derived_one(self) -> None:
        # The formula this replaces (real / (real + derived)) scores 0.0 here no
        # matter how good the derived voice is. Excess-based scoring says what a
        # listener would: half a step worse than perfect is still close.
        self.assertGreater(ab.quality(0.0, 0.5), 0.6)

    def test_far_worse_tends_to_zero_without_reaching_it(self) -> None:
        value = ab.quality(1.0, 100.0)
        self.assertLess(value, 0.02)
        self.assertGreater(value, 0.0)


class BlindingTests(unittest.TestCase):
    def test_the_real_arm_is_not_always_a(self) -> None:
        arms = {ab.arm_order(f"angry/spk{i}")[0] for i in range(24)}
        self.assertEqual(arms, {"A", "B"})

    def test_the_same_pair_always_lands_the_same_way(self) -> None:
        self.assertEqual(ab.arm_order("angry/mary"), ab.arm_order("angry/mary"))

    def test_the_scorer_is_told_nothing_about_which_arm_is_which(self) -> None:
        near = probe(f0_mean=205.0, f0_sd=30.0, energy_rms=0.1, rate_proxy=4.0,
                     spectral_tilt=-10.0)
        far = probe(f0_mean=280.0, f0_sd=60.0, energy_rms=0.05, rate_proxy=7.0,
                    spectral_tilt=-2.0)
        forward = ab.score_blind({"A": near, "B": far}, TARGET)
        swapped = ab.score_blind({"A": far, "B": near}, TARGET)
        self.assertEqual(forward["A"], swapped["B"])
        self.assertEqual(forward["B"], swapped["A"])

    def test_compare_unblinds_correctly_whichever_arm_the_real_one_got(self) -> None:
        near = probe(f0_mean=205.0, f0_sd=30.0, energy_rms=0.1, rate_proxy=4.0,
                     spectral_tilt=-10.0)
        far = probe(f0_mean=280.0, f0_sd=60.0, energy_rms=0.05, rate_proxy=7.0,
                    spectral_tilt=-2.0)
        seen = set()
        for key in (f"angry/spk{i}" for i in range(24)):
            report = ab.compare(key, TARGET, near, far)
            seen.add(report["real_arm"])
            # Whichever arm it landed in, the REAL render is the near one.
            self.assertLess(report["real"], report["derived"])
            self.assertLess(report["quality"], 1.0)
        self.assertEqual(seen, {"A", "B"})  # ...and both assignments happened

    def test_an_unmeasurable_pair_names_itself_and_scores_nothing(self) -> None:
        report = ab.compare("angry/mary", TARGET, probe(f0_mean=200.0), TARGET)
        self.assertIsNone(report["quality"])
        self.assertIn("prosody fields", report["reason"])


class AggregateTests(unittest.TestCase):
    def test_the_published_number_is_the_median(self) -> None:
        self.assertEqual(ab.aggregate([0.9, 0.9, 0.1]), 0.9)

    def test_nothing_measured_publishes_nothing(self) -> None:
        self.assertIsNone(ab.aggregate([]))


class _AbCase(_SeamCase):
    """A registry + a built basis + stored prosody on the real slots."""

    def setUp(self) -> None:
        super().setUp()
        self.rows: dict = {}
        for cid, slots in COHERENT.items():
            for emotion, vec in slots.items():
                vid = f"{cid}-{emotion}"
                from service.tests.test_emotion_basis import fake_save
                fake_save(self.root / f"{vid}.safetensors", {"e": np.asarray(vec)})
                row = {"character_id": cid, "emotion": emotion,
                       "name": cid.title(), "created": "2026-07-01T00:00:00"}
                if emotion != "baseline":
                    row["prosody"] = dict(TARGET)
                self.rows[vid] = row
        self.save()
        eb.build(self.root)

    def save(self) -> None:
        (self.root / "_meta.json").write_text(
            json.dumps({"voices": self.rows, "characters": {}}), "utf-8")

    def basis(self) -> eb.Basis:
        basis, reason = eb.load(self.root)
        self.assertIsNone(reason)
        return basis

    def transfer_block(self) -> dict:
        return json.loads((self.root / eb.BASIS_JSON).read_text("utf-8")).get(
            eb.TRANSFER_KEY, {})


class CandidateTests(_AbCase):
    def test_only_speakers_with_a_real_probed_take_are_testable(self) -> None:
        pairs = ab.candidates(self.rows, self.basis())
        self.assertEqual([(e, c) for e, c, _v, _b in pairs],
                         [("angry", "mary"), ("angry", "paul"), ("angry", "vera")])

    def test_a_take_with_no_stored_probe_has_nothing_to_be_judged_against(self) -> None:
        self.rows["mary-angry"].pop("prosody")
        pairs = ab.candidates(self.rows, self.basis())
        self.assertNotIn("mary", [c for _e, c, _v, _b in pairs])

    def test_a_derived_take_is_not_a_control(self) -> None:
        self.rows["paul-angry"]["origin"] = "derived"
        pairs = ab.candidates(self.rows, self.basis())
        self.assertNotIn("paul", [c for _e, c, _v, _b in pairs])

    def test_an_emotion_the_basis_never_learned_is_not_tested(self) -> None:
        self.assertEqual(ab.candidates(self.rows, self.basis(), ["whisper"]), [])

    def test_the_order_is_stable(self) -> None:
        self.assertEqual(ab.candidates(self.rows, self.basis()),
                         sorted(ab.candidates(self.rows, self.basis())))


class RunTests(_AbCase):
    """The seam is stubbed; everything else is the real tool."""

    def _measure(self, near_derived: bool):
        near = probe(f0_mean=202.0, f0_sd=30.0, energy_rms=0.1, rate_proxy=4.0,
                     spectral_tilt=-10.0)
        far = probe(f0_mean=300.0, f0_sd=90.0, energy_rms=0.02, rate_proxy=9.0,
                    spectral_tilt=2.0)

        def measure(_engine, voice_id, _text, _work):
            staged = voice_id.startswith(ab.STAGE_PREFIX)
            if staged:
                return dict(near if near_derived else far)
            return dict(near)

        return measure

    def _run(self, **kw):
        with mock.patch.object(ab, "open_engine", return_value=(mock.Mock(), None)):
            return ab.run(self.root, **kw)

    def test_a_good_derived_voice_publishes_a_passing_number(self) -> None:
        self._run(measure_fn=self._measure(near_derived=True))
        block = self.transfer_block()
        self.assertEqual(block["version"], eb.TRANSFER_VERSION)
        entry = block["emotions"]["angry"]
        self.assertEqual(entry["quality"], 1.0)
        self.assertEqual(entry["speakers"], 3)
        # Every speaker tested here also built the direction -- said, not hidden.
        self.assertEqual(entry["in_sample"], 3)
        self.assertIn("measured", entry)

    def test_a_bad_derived_voice_publishes_a_failing_number(self) -> None:
        self._run(measure_fn=self._measure(near_derived=False))
        entry = self.transfer_block()["emotions"]["angry"]
        self.assertLess(entry["quality"], eb.MIN_TRANSFER_QUALITY)
        # ...and the gate that reads it refuses on exactly this file.
        _measured, refusal = eb.transfer_gate(self.basis(), "angry")
        self.assertIn("transfer quality", refusal)

    def test_the_number_reaches_the_loaded_basis(self) -> None:
        self._run(measure_fn=self._measure(near_derived=True))
        basis = self.basis()
        self.assertEqual(basis.transfer["angry"].speakers, 3)
        self.assertEqual(basis.transfer["angry"].quality, 1.0)

    def test_the_staged_embedding_never_survives_the_run(self) -> None:
        self._run(measure_fn=self._measure(near_derived=True))
        staged = [p.name for p in self.root.glob(f"{ab.STAGE_PREFIX}*")]
        self.assertEqual(staged, [])

    def test_a_render_failure_costs_one_pair_not_the_run(self) -> None:
        real = self._measure(near_derived=True)

        def flaky(engine, voice_id, text, work):
            if voice_id == "mary-angry":
                raise RuntimeError("the model fell over")
            return real(engine, voice_id, text, work)

        self._run(measure_fn=flaky)
        self.assertEqual(self.transfer_block()["emotions"]["angry"]["speakers"], 2)

    def test_dry_run_writes_nothing(self) -> None:
        self._run(dry_run=True, measure_fn=self._measure(near_derived=True))
        self.assertEqual(self.transfer_block(), {})

    def test_no_write_reports_without_touching_the_manifest(self) -> None:
        self._run(write=False, measure_fn=self._measure(near_derived=True))
        self.assertEqual(self.transfer_block(), {})

    def test_a_box_with_no_engine_writes_nothing_and_names_why(self) -> None:
        with mock.patch.object(ab, "open_engine",
                               return_value=(None, "engine unavailable (no torch)")):
            ab.run(self.root, measure_fn=self._measure(near_derived=True))
        self.assertEqual(self.transfer_block(), {})

    def test_no_basis_is_a_named_skip_not_a_crash(self) -> None:
        (self.root / eb.BASIS_JSON).unlink()
        self.assertEqual(self._run(measure_fn=self._measure(near_derived=True)), 0)

    def test_measuring_again_updates_rather_than_duplicates(self) -> None:
        self._run(measure_fn=self._measure(near_derived=False))
        self._run(measure_fn=self._measure(near_derived=True))
        self.assertEqual(self.transfer_block()["emotions"]["angry"]["quality"], 1.0)

    def test_rebuilding_the_basis_drops_measurements_of_the_old_one(self) -> None:
        self._run(measure_fn=self._measure(near_derived=True))
        eb.build(self.root)
        self.assertEqual(self.transfer_block(), {})
        self.assertEqual(self.basis().transfer, {})


class StageTests(_AbCase):
    def test_the_staged_voice_is_baseline_plus_the_calibrated_step(self) -> None:
        entry = self.basis().emotions["angry"]
        voice_id, path = ab.stage_derived(self.root, "mary-baseline", entry)
        try:
            self.assertTrue(voice_id.startswith(ab.STAGE_PREFIX))
            written = fake_load(path)["e"]
            baseline = fake_load(self.root / "mary-baseline.safetensors")["e"]
            np.testing.assert_allclose(written, baseline + entry.alpha * entry.vector,
                                       rtol=1e-6, atol=1e-6)
            self.assertEqual(written.shape, (DIM,))
        finally:
            path.unlink(missing_ok=True)

    def test_the_staged_name_hides_from_the_roster_glob(self) -> None:
        # voices._cloned_voices skips underscore files; a crashed run must not
        # leave something the roster turns into a Character.
        entry = self.basis().emotions["angry"]
        voice_id, path = ab.stage_derived(self.root, "mary-baseline", entry)
        path.unlink(missing_ok=True)
        self.assertTrue(voice_id.startswith("_"))


class WriteTransferTests(_AbCase):
    def test_a_measurement_for_an_emotion_the_file_lacks_is_not_invented(self) -> None:
        self.assertIsNone(eb.write_transfer(
            self.root, {"whisper": {"quality": 0.9, "speakers": 2, "in_sample": 0}}))
        self.assertEqual(self.transfer_block()["emotions"], {})

    def test_measuring_a_second_emotion_keeps_the_first(self) -> None:
        eb.write_transfer(self.root, {"angry": {"quality": 0.8, "speakers": 2,
                                                "in_sample": 1}})
        raw = json.loads((self.root / eb.BASIS_JSON).read_text("utf-8"))
        raw["emotions"]["whisper"] = dict(raw["emotions"]["angry"])
        (self.root / eb.BASIS_JSON).write_text(json.dumps(raw), "utf-8")
        eb.write_transfer(self.root, {"whisper": {"quality": 0.7, "speakers": 2,
                                                  "in_sample": 0}})
        emotions = self.transfer_block()["emotions"]
        self.assertEqual(sorted(emotions), ["angry", "whisper"])
        self.assertEqual(emotions["angry"]["quality"], 0.8)

    def test_no_basis_at_all_is_a_sentence_not_a_write(self) -> None:
        with TemporaryDirectory() as td:
            reason = eb.write_transfer(Path(td), {"angry": {"quality": 0.9,
                                                            "speakers": 2}})
        self.assertIn("nothing to record transfer quality against", reason)

    def test_a_manifest_from_another_version_refuses_by_name(self) -> None:
        path = self.root / eb.BASIS_JSON
        raw = json.loads(path.read_text("utf-8"))
        raw["version"] = eb.BASIS_VERSION + 7
        path.write_text(json.dumps(raw), "utf-8")
        reason = eb.write_transfer(self.root, {"angry": {"quality": 0.9,
                                                         "speakers": 2}})
        self.assertIn("rebuild it", reason)


if __name__ == "__main__":
    unittest.main()
