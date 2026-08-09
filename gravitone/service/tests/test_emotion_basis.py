"""The shared emotion basis: what it averages, what it refuses, what alpha means.

Same rule as `test_emotion_residuals`: no real embeddings exist on this box, so
the tensor seam (`emotion_residuals.load_embedding` / `save_embedding`) is
swapped for an npz-backed pair and every number under test is one this file
CHOSE. What that proves:

  * the direction is the average of the contributors' residuals, normalised;
  * `alpha` is calibrated LEAVE-ONE-SPEAKER-OUT and is a MEDIAN -- asserted by
    building a corpus where the mean and the median differ, so a regression to
    "average the projections" fails here rather than in a voice that sounds
    wrong;
  * an emotion below the coherence bar is not written, and cannot be asked for;
  * every failure mode comes back as a SENTENCE, not as a missing file.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import numpy as np

from service import emotion_basis as eb
from service.tools import emotion_residuals as res
from service.tests.test_emotion_residuals import (
    COHERENT, INCOHERENT, _at_angle, _axis, _speakers, DIM,
)


# -- a tensor backend made of numpy, standing in for safetensors ---------------
def fake_save(path, tensors) -> None:
    # Written through an open handle, not a name: np.savez appends `.npz` to a
    # path string, and these files must land under the exact `.safetensors`
    # names the registry and the basis loader look for.
    with open(path, "wb") as fh:
        np.savez(fh, **{k: np.asarray(v) for k, v in tensors.items()})


def fake_load(path) -> dict:
    path = Path(path)
    if not path.is_file():
        raise OSError(f"no such embedding: {path}")
    with open(path, "rb") as fh:
        with np.load(fh, allow_pickle=False) as z:
            return {k: z[k] for k in z.files}


def tensor_seam():
    """Patch the ONE seam every embedding path in this feature reads through."""
    return (mock.patch.object(res, "save_embedding", fake_save),
            mock.patch.object(res, "load_embedding", fake_load))


class _SeamCase(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.root = Path(self._dir.name)
        self._patches = list(tensor_seam())
        for p in self._patches:
            p.start()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        self._dir.cleanup()

    def seed(self, vectors: dict) -> None:
        """Write a registry + one npz per voice for a {cid: {emotion: vec}} corpus."""
        rows = {}
        for cid, slots in vectors.items():
            for emotion, vec in slots.items():
                vid = f"{cid}-{emotion}"
                rows[vid] = {"character_id": cid, "emotion": emotion}
                fake_save(self.root / f"{vid}.safetensors", {"e": np.asarray(vec)})
        (self.root / "_meta.json").write_text(json.dumps({"voices": rows}), "utf-8")


class AlphaTests(unittest.TestCase):
    def test_alpha_is_how_far_a_real_take_sits_along_the_others_direction(self) -> None:
        residuals = {c: 2.0 * _axis(0) for c in ("mary", "paul", "vera")}
        alpha, held_out = eb.calibrate_alpha(residuals)
        self.assertAlmostEqual(alpha, 2.0)
        self.assertEqual(held_out, 3)

    def test_alpha_is_the_median_so_one_huge_take_cannot_set_the_step(self) -> None:
        # Projections come out (1, 1, 10): the median is 1, the mean is 4.
        residuals = {"mary": 1.0 * _axis(0), "paul": 1.0 * _axis(0),
                     "vera": 10.0 * _axis(0)}
        alpha, _held = eb.calibrate_alpha(residuals)
        self.assertAlmostEqual(alpha, 1.0)

    def test_one_contributor_cannot_be_held_out_of_anything(self) -> None:
        self.assertEqual(eb.calibrate_alpha({"mary": _axis(0)}), (None, 0))

    def test_alpha_is_fitted_against_speakers_the_direction_never_saw(self) -> None:
        # If alpha were fitted in-sample it would be pulled toward the average of
        # ALL residuals; held out, each speaker is measured against the others.
        residuals = {"mary": 4.0 * _axis(0), "paul": 4.0 * _axis(0),
                     "vera": 4.0 * _at_angle(0.9, 1)}
        alpha, held_out = eb.calibrate_alpha(residuals)
        self.assertEqual(held_out, 3)
        self.assertLess(alpha, 4.0)  # the off-axis speaker projects shorter
        self.assertGreater(alpha, 3.0)


class BuildTests(_SeamCase):
    def test_a_coherent_corpus_produces_a_basis(self) -> None:
        self.seed(COHERENT)
        report = eb.build(self.root)
        self.assertTrue(report["written"])
        self.assertIn("angry", report["emotions"])
        entry = report["emotions"]["angry"]
        self.assertAlmostEqual(entry["coherence"], round((0.9 + 0.9 + 0.81) / 3, 4),
                               places=3)
        self.assertEqual(sorted(entry["contributors"]), ["mary", "paul", "vera"])
        self.assertEqual(entry["held_out"], 3)
        self.assertTrue((self.root / eb.BASIS_TENSORS).is_file())
        self.assertTrue((self.root / eb.BASIS_JSON).is_file())

    def test_an_incoherent_emotion_is_reported_and_not_written(self) -> None:
        self.seed(INCOHERENT)
        report = eb.build(self.root)
        self.assertFalse(report["written"])
        self.assertEqual(report["emotions"], {})
        self.assertEqual(report["rejected"]["angry"]["verdict"], "no-go")
        # Nothing was written, so nothing can later be derived by accident.
        self.assertFalse((self.root / eb.BASIS_JSON).is_file())

    def test_a_single_speaker_is_not_enough_to_build_from(self) -> None:
        self.seed(_speakers({"mary": _axis(0)}))
        report = eb.build(self.root)
        self.assertFalse(report["written"])
        self.assertEqual(report["rejected"]["angry"]["verdict"], "no-data")

    def test_the_bar_can_be_raised_but_never_bypassed(self) -> None:
        self.seed(COHERENT)
        self.assertFalse(eb.build(self.root, min_coherence=0.99)["written"])

    def test_a_box_without_the_package_raises_once_and_names_it(self) -> None:
        self.seed(COHERENT)
        with mock.patch.object(res, "load_embedding",
                               side_effect=res.TensorsUnavailable("no safetensors")):
            with self.assertRaises(res.TensorsUnavailable):
                eb.build(self.root)


class LoadTests(_SeamCase):
    def _built(self) -> eb.Basis:
        self.seed(COHERENT)
        eb.build(self.root)
        basis, reason = eb.load(self.root)
        self.assertIsNone(reason)
        assert basis is not None
        return basis

    def test_a_built_basis_round_trips(self) -> None:
        basis = self._built()
        self.assertEqual(basis.version, eb.BASIS_VERSION)
        self.assertEqual(sorted(basis.emotions), ["angry"])
        entry = basis.emotions["angry"]
        self.assertEqual(entry.vector.shape, (DIM,))
        self.assertAlmostEqual(float(np.linalg.norm(entry.vector)), 1.0, places=6)
        self.assertEqual(basis.dim, DIM)

    def test_no_basis_yet_is_a_sentence_not_an_exception(self) -> None:
        basis, reason = eb.load(self.root)
        self.assertIsNone(basis)
        self.assertIn("no emotion basis has been built", reason)

    def test_a_basis_from_another_version_is_refused_by_name(self) -> None:
        self._built()
        path = self.root / eb.BASIS_JSON
        raw = json.loads(path.read_text("utf-8"))
        raw["version"] = eb.BASIS_VERSION + 7
        path.write_text(json.dumps(raw), "utf-8")
        basis, reason = eb.load(self.root)
        self.assertIsNone(basis)
        self.assertIn("different version", reason)

    def test_a_damaged_manifest_is_named_not_repaired(self) -> None:
        self._built()
        (self.root / eb.BASIS_JSON).write_text("{ not json", "utf-8")
        basis, reason = eb.load(self.root)
        self.assertIsNone(basis)
        self.assertIn("unreadable", reason)

    def test_unreadable_tensors_report_the_box_problem_verbatim(self) -> None:
        self._built()
        with mock.patch.object(res, "load_embedding",
                               side_effect=res.TensorsUnavailable("safetensors is absent")):
            basis, reason = eb.load(self.root)
        self.assertIsNone(basis)
        self.assertEqual(reason, "safetensors is absent")

    def test_the_manifest_is_written_after_the_tensors(self) -> None:
        # A crash between the two writes must leave "not built", never a
        # manifest promising vectors that are not on disk.
        self.seed(COHERENT)
        with mock.patch.object(res, "save_embedding", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                eb.build(self.root)
        self.assertFalse((self.root / eb.BASIS_JSON).is_file())


class DirectionGateTests(_SeamCase):
    def setUp(self) -> None:
        super().setUp()
        self.seed(COHERENT)
        eb.build(self.root)
        self.basis, _ = eb.load(self.root)

    def test_an_emotion_the_basis_never_learned_is_named(self) -> None:
        entry, reason = eb.direction(self.basis, "whisper")
        self.assertIsNone(entry)
        self.assertIn("no 'whisper' direction", reason)
        self.assertIn("angry", reason)  # ...and says what it DOES carry

    def test_the_coherence_bar_names_both_numbers(self) -> None:
        entry, reason = eb.direction(self.basis, "angry", min_coherence=0.99)
        self.assertIsNone(entry)
        self.assertIn("0.99", reason)
        self.assertIn("coherence", reason)

    def test_a_good_emotion_comes_back_with_its_evidence(self) -> None:
        entry, reason = eb.direction(self.basis, "angry")
        self.assertIsNone(reason)
        self.assertEqual(entry.emotion, "angry")
        self.assertGreaterEqual(entry.coherence, eb.MIN_COHERENCE)
        self.assertEqual(entry.contributors, ("mary", "paul", "vera"))


class DeriveTensorTests(unittest.TestCase):
    def test_the_derived_embedding_is_baseline_plus_a_step(self) -> None:
        baseline = {"a": np.ones(4, dtype=np.float32), "b": np.zeros(2, dtype=np.float32)}
        vector = res.unit(np.array([1.0, 0, 0, 0, 0, 0]))
        tensors, reason = eb.derive_tensors(baseline, vector, 3.0)
        self.assertIsNone(reason)
        np.testing.assert_allclose(tensors["a"], [4.0, 1.0, 1.0, 1.0])
        np.testing.assert_allclose(tensors["b"], [0.0, 0.0])

    def test_the_source_dtype_survives(self) -> None:
        baseline = {"a": np.ones(4, dtype=np.float32)}
        tensors, _ = eb.derive_tensors(baseline, np.zeros(4), 1.0)
        self.assertEqual(tensors["a"].dtype, np.float32)

    def test_a_basis_built_for_another_model_is_refused_with_both_sizes(self) -> None:
        tensors, reason = eb.derive_tensors({"a": np.ones(4)}, np.ones(9), 1.0)
        self.assertIsNone(tensors)
        self.assertIn("4", reason)
        self.assertIn("9", reason)

    def test_an_empty_baseline_is_refused(self) -> None:
        tensors, reason = eb.derive_tensors({}, np.ones(0), 1.0)
        self.assertIsNone(tensors)
        self.assertIn("empty", reason)

    def test_a_non_finite_result_is_never_written(self) -> None:
        baseline = {"a": np.array([np.inf, 0.0, 0.0, 0.0])}
        tensors, reason = eb.derive_tensors(baseline, np.zeros(4), 1.0)
        self.assertIsNone(tensors)
        self.assertIn("finite", reason)


class DonorDirectionTests(unittest.TestCase):
    def test_the_donors_own_delta_is_reproduced_exactly(self) -> None:
        base = {"e": np.full(DIM, 5.0)}
        take = {"e": np.full(DIM, 5.0) + 3.0 * _axis(0)}
        vector, alpha, reason = eb.donor_direction(base, take)
        self.assertIsNone(reason)
        self.assertAlmostEqual(alpha, 3.0)
        np.testing.assert_allclose(vector * alpha, 3.0 * _axis(0), atol=1e-9)

    def test_a_donor_take_identical_to_its_baseline_carries_no_emotion(self) -> None:
        base = {"e": np.ones(8)}
        vector, _alpha, reason = eb.donor_direction(base, {"e": np.ones(8)})
        self.assertIsNone(vector)
        self.assertIn("identical to its own baseline", reason)

    def test_a_donor_from_another_model_is_named_not_broadcast(self) -> None:
        vector, _alpha, reason = eb.donor_direction({"e": np.ones(8)}, {"e": np.ones(9)})
        self.assertIsNone(vector)
        self.assertIn("different models", reason)


class TransferStateTests(unittest.TestCase):
    """"Unmeasured" must never look like "measured and fine".

    The transfer-quality gate is built and enforced, but the block it reads is
    written by `service/tools/derive_ab.py`, which has zero callers -- so on
    every install today `transfer` is empty and the gate says "never measured,
    derive anyway". That policy is deliberate (see `transfer_gate`), and it is
    only defensible if the derived row SAYS which of the three states it is in.
    A null `quality` is not saying it: every consumer that coerces turns it into
    0.0 or 1.0, and both are lies about a measurement that never happened.
    """

    def basis(self, **transfer: eb.TransferQuality) -> eb.Basis:
        emotions = {name: eb.EmotionBasis(name, np.ones(4) / 2.0, 1.0, 0.9,
                                          ("mary", "paul"), 2)
                    for name in ("angry", "sad", "whisper")}
        return eb.Basis(version=eb.BASIS_VERSION, created="now",
                        layout=(("e", (4,)),), emotions=emotions,
                        transfer=dict(transfer))

    # -- measured and passing --------------------------------------------------
    def test_measured_and_passing_derives_and_carries_its_number(self) -> None:
        entry = eb.TransferQuality("angry", 0.91, 3, in_sample=2, measured="2026-01-01Z")
        payload, refusal = eb.transfer_check(self.basis(angry=entry), "angry")
        self.assertIsNone(refusal)
        self.assertEqual(payload["state"], eb.TRANSFER_MEASURED)
        self.assertEqual(payload["quality"], 0.91)
        self.assertEqual(payload["speakers"], 3)
        self.assertEqual(payload["in_sample"], 2)
        self.assertEqual(payload["measured"], "2026-01-01Z")
        self.assertEqual(payload["min_quality"], eb.MIN_TRANSFER_QUALITY)

    def test_exactly_on_the_bar_passes(self) -> None:
        entry = eb.TransferQuality("angry", eb.MIN_TRANSFER_QUALITY, 2)
        payload, refusal = eb.transfer_check(self.basis(angry=entry), "angry")
        self.assertIsNone(refusal)
        self.assertEqual(payload["state"], eb.TRANSFER_MEASURED)

    # -- measured and failing --------------------------------------------------
    def test_measured_and_failing_refuses_naming_both_numbers_and_the_fix(self) -> None:
        entry = eb.TransferQuality("angry", 0.2, 3)
        payload, refusal = eb.transfer_check(self.basis(angry=entry), "angry")
        self.assertIn("0.20", refusal)
        self.assertIn("0.50", refusal)
        self.assertIn("3 speaker(s)", refusal)
        # the refusal names the command that would change the answer
        self.assertIn("python -m service.tools ab", refusal)
        # ...and the payload still states what it is, for anything that logs it
        self.assertEqual(payload["state"], eb.TRANSFER_BELOW_BAR)
        self.assertEqual(payload["quality"], 0.2)

    # -- never measured --------------------------------------------------------
    def test_never_measured_derives_but_is_named_not_nulled(self) -> None:
        payload, refusal = eb.transfer_check(self.basis(), "angry")
        self.assertIsNone(refusal, "the policy is allow-with-a-named-state")
        self.assertEqual(payload["state"], eb.TRANSFER_UNMEASURED)
        self.assertIsNone(payload["quality"])

    def test_the_unmeasured_row_invents_no_number_for_a_measurement(self) -> None:
        payload = eb.transfer_payload(None)
        self.assertIsNone(payload["quality"])
        self.assertNotIn(payload["quality"], (0.0, 1.0))
        # `speakers: 0` is a COUNT of speakers actually tested, which is zero --
        # not a stand-in for a quality.
        self.assertEqual(payload["speakers"], 0)
        self.assertEqual(payload["in_sample"], 0)
        self.assertIsNone(payload["measured"])

    def test_an_emotion_measured_elsewhere_does_not_lend_its_number(self) -> None:
        basis = self.basis(sad=eb.TransferQuality("sad", 0.99, 4))
        payload, refusal = eb.transfer_check(basis, "angry")
        self.assertIsNone(refusal)
        self.assertEqual(payload["state"], eb.TRANSFER_UNMEASURED)
        self.assertEqual(eb.transfer_check(basis, "sad")[0]["state"],
                         eb.TRANSFER_MEASURED)

    # -- the shape itself ------------------------------------------------------
    def test_all_three_states_publish_the_same_key_set(self) -> None:
        keys = {"state", "quality", "speakers", "in_sample", "min_quality",
                "measured", "version"}
        basis = self.basis(angry=eb.TransferQuality("angry", 0.9, 2),
                           sad=eb.TransferQuality("sad", 0.1, 2))
        for emotion, expected in (("angry", eb.TRANSFER_MEASURED),
                                  ("sad", eb.TRANSFER_BELOW_BAR),
                                  ("whisper", eb.TRANSFER_UNMEASURED)):
            with self.subTest(emotion=emotion):
                payload, _refusal = eb.transfer_check(basis, emotion)
                # No state may be inferable only from which keys are missing.
                self.assertEqual(set(payload), keys)
                self.assertEqual(payload["state"], expected)
                self.assertIn(payload["state"], eb.TRANSFER_STATES)
                self.assertEqual(payload["version"], eb.TRANSFER_VERSION)

    def test_the_bar_the_state_was_decided_against_travels_with_it(self) -> None:
        # A row stored today has to stay readable after MIN_TRANSFER_QUALITY
        # moves: "measured" without the bar it cleared is not a fact.
        entry = eb.TransferQuality("angry", 0.6, 2)
        strict, refusal = eb.transfer_check(self.basis(angry=entry), "angry",
                                            min_quality=0.9)
        self.assertIsNotNone(refusal)
        self.assertEqual(strict["state"], eb.TRANSFER_BELOW_BAR)
        self.assertEqual(strict["min_quality"], 0.9)

    def test_the_gate_and_the_payload_cannot_disagree(self) -> None:
        for quality in (0.0, 0.49, 0.5, 0.51, 1.0):
            with self.subTest(quality=quality):
                entry = eb.TransferQuality("angry", quality, 2)
                basis = self.basis(angry=entry)
                _e, refusal = eb.transfer_gate(basis, "angry")
                payload, check_refusal = eb.transfer_check(basis, "angry")
                self.assertEqual(refusal, check_refusal)
                self.assertEqual(payload["state"] == eb.TRANSFER_BELOW_BAR,
                                 refusal is not None)


class RefusalCopyTests(_SeamCase):
    """A refusal that tells the operator how to stop being refused.

    On a fresh checkout the derive endpoint's 422 was the end of the road: no
    basis exists, none of the tools that build one has a caller, and the command
    was documented nowhere the refused person would look.
    """

    def test_no_basis_names_the_command_its_deps_and_what_it_writes(self) -> None:
        basis, reason = eb.load(self.root)
        self.assertIsNone(basis)
        self.assertIn("no emotion basis has been built", reason)
        self.assertIn("python -m service.tools basis", reason)
        self.assertIn("safetensors", reason)          # what it needs
        self.assertIn("seconds to minutes", reason)   # roughly how long
        self.assertIn("_basis.safetensors", reason)   # what it writes
        self.assertIn("python -m service.tools residuals", reason)  # check first

    def test_a_basis_from_another_version_says_how_to_rebuild_it(self) -> None:
        self.seed(COHERENT)
        eb.build(self.root)
        path = self.root / eb.BASIS_JSON
        raw = json.loads(path.read_text("utf-8"))
        raw["version"] = eb.BASIS_VERSION + 1
        path.write_text(json.dumps(raw), "utf-8")
        _basis, reason = eb.load(self.root)
        self.assertIn("different version", reason)
        self.assertIn("python -m service.tools basis", reason)

    def test_an_emotion_the_basis_lacks_says_what_would_add_it(self) -> None:
        self.seed(COHERENT)
        eb.build(self.root)
        basis, _reason = eb.load(self.root)
        entry, reason = eb.direction(basis, "whisper")
        self.assertIsNone(entry)
        self.assertIn("two or more characters", reason)
        self.assertIn("python -m service.tools basis", reason)

    def test_recording_transfer_against_nothing_says_how_to_build_it(self) -> None:
        reason = eb.write_transfer(self.root, {"angry": {"quality": 0.9,
                                                         "speakers": 2}})
        self.assertIn("nothing to record transfer quality against", reason)
        self.assertIn("python -m service.tools basis", reason)


if __name__ == "__main__":
    unittest.main()
