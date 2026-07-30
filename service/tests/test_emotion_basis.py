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


if __name__ == "__main__":
    unittest.main()
