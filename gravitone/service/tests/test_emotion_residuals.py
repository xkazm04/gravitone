"""The measurement gate: does (emotion - baseline) transfer between speakers?

This is the test that lets Emotion Algebra be a product decision instead of a
hope. The corpus needs the Arm box (reading a real `.safetensors` needs a
package that is not installed here, and the embeddings themselves live with the
model) -- so what is proven HERE is the arithmetic, over synthetic tensors whose
geometry is CONSTRUCTED, not sampled:

  * a coherent set (three speakers whose residuals sit at known small angles)
    must come back above the go bar and be called `go`;
  * an incoherent set (mutually orthogonal residuals) must come back at zero and
    be called `no-go`;
  * a deliberately middling set (cosine 0.25, between the two bars) must be
    called `inconclusive` -- the verdict that exists so "not no" cannot be read
    as "yes".

If the summary can call all three correctly on numbers we chose, then on the Arm
box it is measuring the corpus rather than the code.
"""
from __future__ import annotations

import json
import math
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import numpy as np

from service.tools import emotion_residuals as res

DIM = 64


def _axis(i: int, dim: int = DIM) -> np.ndarray:
    v = np.zeros(dim, dtype=np.float64)
    v[i] = 1.0
    return v


def _at_angle(cos_theta: float, other_axis: int, dim: int = DIM) -> np.ndarray:
    """A unit vector whose cosine with `_axis(0)` is EXACTLY `cos_theta`."""
    return cos_theta * _axis(0, dim) + math.sqrt(1.0 - cos_theta ** 2) * _axis(other_axis, dim)


def _speakers(residuals: dict[str, np.ndarray], emotion: str = "angry",
              dim: int = DIM) -> dict[str, dict[str, np.ndarray]]:
    """{cid: {baseline, emotion}} whose residual is exactly what was asked for.

    Each speaker gets its OWN baseline (a different point in the space), which is
    the property under test: the residual must be about the emotion, not about
    where the speaker happens to sit.
    """
    out: dict[str, dict[str, np.ndarray]] = {}
    for i, (cid, residual) in enumerate(sorted(residuals.items())):
        base = np.full(dim, float(i + 1) * 3.0)
        out[cid] = {"baseline": base, emotion: base + residual}
    return out


COHERENT = _speakers({
    "mary": _axis(0),
    "paul": _at_angle(0.9, 1),
    "vera": _at_angle(0.9, 2),
})
INCOHERENT = _speakers({"mary": _axis(0), "paul": _axis(1), "vera": _axis(2)})
MIDDLING = _speakers({"mary": _axis(0), "paul": _at_angle(0.25, 1)})


class GeometryTests(unittest.TestCase):
    def test_flatten_is_sorted_and_unflatten_is_its_inverse(self) -> None:
        tensors = {"b": np.arange(6.0).reshape(2, 3), "a": np.array([9.0, 8.0])}
        flat = res.flatten(tensors)
        # 'a' first: sorted key order, not dict order -- two embeddings written in
        # different orders must still be comparable.
        self.assertEqual(list(flat[:2]), [9.0, 8.0])
        back = res.unflatten(flat, res.layout_of(tensors))
        self.assertEqual(sorted(back), ["a", "b"])
        for k in tensors:
            np.testing.assert_allclose(back[k], tensors[k])

    def test_unflatten_refuses_a_vector_that_does_not_fit(self) -> None:
        layout = res.layout_of({"a": np.zeros(4)})
        with self.assertRaises(ValueError):
            res.unflatten(np.zeros(3), layout)
        with self.assertRaises(ValueError):
            res.unflatten(np.zeros(5), layout)

    def test_unflatten_handles_a_scalar_tensor(self) -> None:
        tensors = {"scale": np.array(2.5), "v": np.ones(3)}
        back = res.unflatten(res.flatten(tensors), res.layout_of(tensors))
        self.assertEqual(back["scale"].shape, ())
        self.assertEqual(float(back["scale"]), 2.5)

    def test_cosine_says_nothing_rather_than_guessing(self) -> None:
        self.assertIsNone(res.cosine(np.zeros(4), np.ones(4)))      # no direction
        self.assertIsNone(res.cosine(np.ones(4), np.ones(5)))       # not comparable
        self.assertIsNone(res.cosine(np.zeros(0), np.zeros(0)))     # nothing there
        self.assertAlmostEqual(res.cosine(_axis(0), _axis(0)), 1.0)
        self.assertAlmostEqual(res.cosine(_axis(0), _axis(1)), 0.0)
        self.assertAlmostEqual(res.cosine(_axis(0), -_axis(0)), -1.0)

    def test_unit_is_none_for_a_vector_that_points_nowhere(self) -> None:
        self.assertIsNone(res.unit(np.zeros(8)))
        np.testing.assert_allclose(res.unit(np.array([3.0, 4.0])), [0.6, 0.8])


class ResidualTests(unittest.TestCase):
    def test_a_speaker_without_a_baseline_contributes_nothing(self) -> None:
        vectors = {"mary": {"angry": _axis(0)}}  # no origin to subtract from
        self.assertEqual(res.residuals_by_emotion(vectors), {})

    def test_a_slot_of_a_different_size_is_skipped_not_broadcast(self) -> None:
        vectors = {"mary": {"baseline": np.zeros(DIM), "angry": np.zeros(8)}}
        self.assertEqual(res.residuals_by_emotion(vectors), {})

    def test_the_residual_is_the_emotion_not_the_speaker(self) -> None:
        # Every speaker in COHERENT sits somewhere different; the residuals must
        # come back as the directions they were built from, undisturbed.
        by_emotion = res.residuals_by_emotion(COHERENT)
        np.testing.assert_allclose(by_emotion["angry"]["mary"], _axis(0), atol=1e-12)
        np.testing.assert_allclose(by_emotion["angry"]["paul"], _at_angle(0.9, 1),
                                   atol=1e-12)


class CoherenceTests(unittest.TestCase):
    def test_one_speaker_is_never_compared_with_itself(self) -> None:
        entry = res.coherence({"mary": _axis(0)})
        self.assertEqual(entry["pairs"], 0)
        self.assertIsNone(entry["mean"])
        self.assertEqual(res.verdict(entry), "no-data")

    def test_a_coherent_set_clears_the_bar(self) -> None:
        entry = res.coherence(res.residuals_by_emotion(COHERENT)["angry"])
        self.assertEqual(entry["pairs"], 3)
        self.assertAlmostEqual(entry["mean"], round((0.9 + 0.9 + 0.81) / 3, 4), places=4)
        self.assertEqual(res.verdict(entry), "go")

    def test_an_incoherent_set_is_a_no_go(self) -> None:
        entry = res.coherence(res.residuals_by_emotion(INCOHERENT)["angry"])
        self.assertAlmostEqual(entry["mean"], 0.0, places=9)
        self.assertEqual(res.verdict(entry), "no-go")

    def test_between_the_bars_is_inconclusive_not_a_yes(self) -> None:
        entry = res.coherence(res.residuals_by_emotion(MIDDLING)["angry"])
        self.assertAlmostEqual(entry["mean"], 0.25, places=6)
        self.assertEqual(res.verdict(entry), "inconclusive")

    def test_opposed_residuals_are_worse_than_unrelated_ones(self) -> None:
        opposed = _speakers({"mary": _axis(0), "paul": -_axis(0)})
        entry = res.coherence(res.residuals_by_emotion(opposed)["angry"])
        self.assertAlmostEqual(entry["mean"], -1.0, places=9)
        self.assertEqual(res.verdict(entry), "no-go")


class SummaryTests(unittest.TestCase):
    def test_the_summary_calls_a_coherent_corpus_go(self) -> None:
        report = res.analyze(COHERENT)
        self.assertEqual(report["summary"]["verdict"], "go")
        self.assertEqual(report["summary"]["derivable"], ["angry"])
        self.assertEqual(report["emotions"]["angry"]["verdict"], "go")

    def test_the_summary_calls_an_incoherent_corpus_no_go(self) -> None:
        report = res.analyze(INCOHERENT)
        self.assertEqual(report["summary"]["verdict"], "no-go")
        self.assertEqual(report["summary"]["derivable"], [])

    def test_a_middling_corpus_decides_nothing(self) -> None:
        report = res.analyze(MIDDLING)
        self.assertEqual(report["summary"]["verdict"], "inconclusive")
        self.assertEqual(report["summary"]["derivable"], [])

    def test_one_speaker_is_no_data_not_a_verdict_about_the_idea(self) -> None:
        report = res.analyze(_speakers({"mary": _axis(0)}))
        self.assertEqual(report["summary"]["verdict"], "no-data")
        self.assertEqual(report["summary"]["emotions_measured"], 0)

    def test_one_good_emotion_makes_the_corpus_a_go_for_that_emotion_only(self) -> None:
        vectors: dict[str, dict[str, np.ndarray]] = {}
        for cid, slots in COHERENT.items():
            vectors[cid] = dict(slots)
        # ...and a `whisper` slot that is pure disagreement.
        for i, cid in enumerate(sorted(vectors)):
            vectors[cid]["whisper"] = vectors[cid]["baseline"] + _axis(10 + i)
        report = res.analyze(vectors)
        self.assertEqual(report["summary"]["verdict"], "go")
        self.assertEqual(report["summary"]["derivable"], ["angry"])
        self.assertEqual(report["emotions"]["whisper"]["verdict"], "no-go")

    def test_the_report_is_json_serializable(self) -> None:
        # The tool's --json mode and the basis builder both round-trip it.
        json.dumps(res.analyze(COHERENT))


class RegistryTests(unittest.TestCase):
    def test_grouping_resolves_a_doubled_slot_the_way_synthesis_does(self) -> None:
        meta = {"voices": {
            "b_second": {"character_id": "mary", "emotion": "angry"},
            "a_first": {"character_id": "mary", "emotion": "angry"},
            "mary_base": {"character_id": "mary", "emotion": "baseline"},
        }}
        grouped = res.group_registry(meta)
        # First in sorted order wins -- one voice per slot, like `_by_emotion`.
        self.assertEqual(grouped["mary"]["angry"], "a_first")

    def test_malformed_rows_are_ignored_not_fatal(self) -> None:
        meta = {"voices": {"x": "nonsense", "y": None, "z": {"character_id": 4},
                           "ok": {"character_id": "mary", "emotion": "baseline"}}}
        self.assertEqual(res.group_registry(meta), {"mary": {"baseline": "ok"}})

    def test_an_unreadable_registry_is_an_empty_plan_not_a_crash(self) -> None:
        with TemporaryDirectory() as td:
            (Path(td) / "_meta.json").write_text("{ not json", "utf-8")
            self.assertEqual(res.load_meta(Path(td)), {"voices": {}})
            # A registry that isn't there at all is simply nothing to measure.
            self.assertEqual(res.load_meta(Path(td) / "nope"), {"voices": {}})


class LoadingTests(unittest.TestCase):
    """What gets OPENED, and what a failure to open is allowed to look like."""

    def _grouped(self):
        return {"mary": {"baseline": "m_base", "angry": "m_angry"},
                "solo": {"baseline": "s_base"}}

    def test_single_slot_speakers_are_never_even_opened(self) -> None:
        opened: list[str] = []

        def fake_load(path):
            opened.append(Path(path).stem)
            return {"t": np.ones(4)}

        with mock.patch.object(res, "load_embedding", fake_load):
            res.load_vectors(Path("."), self._grouped())
        self.assertEqual(sorted(opened), ["m_angry", "m_base"])

    def test_an_unreadable_file_is_a_named_skip(self) -> None:
        skips: list[tuple] = []

        def fake_load(path):
            if Path(path).stem == "m_angry":
                raise OSError("file is truncated")
            return {"t": np.ones(4)}

        with mock.patch.object(res, "load_embedding", fake_load):
            vectors = res.load_vectors(Path("."), self._grouped(),
                                       on_skip=lambda c, e, why: skips.append((c, e, why)))
        # Named, and the speaker drops out (a baseline alone is not a residual).
        self.assertEqual(vectors, {})
        self.assertEqual(skips[0][:2], ("mary", "angry"))
        self.assertIn("truncated", skips[0][2])

    def test_a_box_without_the_package_fails_once_not_per_voice(self) -> None:
        def fake_load(path):
            raise res.TensorsUnavailable("safetensors is not installed")

        with mock.patch.object(res, "load_embedding", fake_load):
            with self.assertRaises(res.TensorsUnavailable):
                res.load_vectors(Path("."), self._grouped())

    def test_load_embedding_names_the_missing_package(self) -> None:
        with mock.patch.object(
                res, "tensor_backend",
                side_effect=res.TensorsUnavailable("safetensors is not installed (x)")):
            with self.assertRaises(res.TensorsUnavailable) as caught:
                res.load_embedding("whatever.safetensors")
            self.assertIn("safetensors", str(caught.exception))


class CliDegradeTests(unittest.TestCase):
    """The dev box: the tool must report WHY it measured nothing, and exit 0."""

    def test_the_tool_degrades_named_when_embeddings_cannot_be_read(self) -> None:
        with TemporaryDirectory() as td:
            (Path(td) / "_meta.json").write_text(json.dumps({"voices": {
                "m_base": {"character_id": "mary", "emotion": "baseline"},
                "m_angry": {"character_id": "mary", "emotion": "angry"},
            }}), "utf-8")
            lines: list[str] = []
            with mock.patch.object(res, "load_embedding",
                                   side_effect=res.TensorsUnavailable("no safetensors here")), \
                 mock.patch.object(res, "_out", lines.append):
                self.assertEqual(res.run(Path(td)), 0)
            joined = "\n".join(lines)
            self.assertIn("skipped: no safetensors here", joined)
            # ...and it still says WHICH speakers would have been measured, so the
            # operator learns whether the corpus is even there.
            self.assertIn("mary", joined)

    def test_the_json_mode_reports_no_data_rather_than_a_verdict(self) -> None:
        with TemporaryDirectory() as td:
            (Path(td) / "_meta.json").write_text(json.dumps({"voices": {
                "m_base": {"character_id": "mary", "emotion": "baseline"},
                "m_angry": {"character_id": "mary", "emotion": "angry"},
            }}), "utf-8")
            lines: list[str] = []
            with mock.patch.object(res, "load_embedding",
                                   side_effect=res.TensorsUnavailable("nope")), \
                 mock.patch.object(res, "_out", lines.append):
                res.run(Path(td), as_json=True)
            report = json.loads("\n".join(lines))
            self.assertEqual(report["summary"]["verdict"], "no-data")
            self.assertEqual(report["summary"]["skipped"], "nope")

    def test_a_measured_run_prints_the_verdict(self) -> None:
        with TemporaryDirectory() as td:
            rows = {}
            tensors = {}
            for cid, slots in COHERENT.items():
                for emotion, vec in slots.items():
                    vid = f"{cid}-{emotion}"
                    rows[vid] = {"character_id": cid, "emotion": emotion}
                    tensors[vid] = {"e": vec}
            (Path(td) / "_meta.json").write_text(json.dumps({"voices": rows}), "utf-8")
            lines: list[str] = []
            with mock.patch.object(res, "load_embedding",
                                   lambda p: tensors[Path(p).stem]), \
                 mock.patch.object(res, "_out", lines.append):
                self.assertEqual(res.run(Path(td)), 0)
            joined = "\n".join(lines)
            self.assertIn("VERDICT go", joined)
            self.assertIn("angry: go", joined)


if __name__ == "__main__":
    unittest.main()
