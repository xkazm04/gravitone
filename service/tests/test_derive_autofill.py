"""Demand-driven autofill: what it picks, what it refuses, what it writes.

The tool answers the coverage queue automatically, so the tests are mostly about
restraint:

  * it picks the HOTTEST missing slot per Character, one each, capped per run,
    in an order two runs agree on;
  * it never picks a slot that is filled, off-palette, has no recorded baseline
    behind it, sits below the coherence bar, or was MEASURED deriving worse than
    a recording -- and each refusal is a sentence, not a silence;
  * `--dry-run` writes nothing and prints the same plan the real run executes;
  * a real run goes through `voices.derive_emotion` itself, so the voice it
    creates is honest (`origin: derived`) and reversible by the ordinary delete.

The tensor seam is the npz pair from `test_emotion_basis`; no real embedding
exists on this box.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import numpy as np

from service.tests import fake_engine  # installs shims -- must precede voices import

import service.voices as vc
from service import demand as demand_mod
from service import emotion_basis as eb
from service.tools import derive_autofill as af
from service.tools import emotion_residuals as res
from service.tests.test_emotion_basis import fake_load, fake_save, tensor_seam
from service.tests.test_emotion_residuals import COHERENT, _axis

DIM = len(_axis(0))


def _c(cid: str, emotion: str, demand: int = 5, coherence: float = 0.9,
       quality: float | None = None) -> af.Candidate:
    return af.Candidate(cid, emotion, demand, coherence, quality)


class CapTests(unittest.TestCase):
    def test_the_default_cap_is_the_named_one(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=False):
            import os
            os.environ.pop(af.AUTOFILL_CAP_ENV, None)
            self.assertEqual(af.cap_setting(), af.AUTOFILL_CAP)

    def test_the_environment_moves_it(self) -> None:
        with mock.patch.dict("os.environ", {af.AUTOFILL_CAP_ENV: "7"}):
            self.assertEqual(af.cap_setting(), 7)

    def test_the_flag_beats_the_environment(self) -> None:
        with mock.patch.dict("os.environ", {af.AUTOFILL_CAP_ENV: "7"}):
            self.assertEqual(af.cap_setting(2), 2)

    def test_nonsense_in_the_environment_falls_back_rather_than_crashing(self) -> None:
        with mock.patch.dict("os.environ", {af.AUTOFILL_CAP_ENV: "lots"}):
            self.assertEqual(af.cap_setting(), af.AUTOFILL_CAP)


class _PlanCase(unittest.TestCase):
    """A registry that can build a basis, plus a speaker waiting to be filled."""

    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.root = Path(self._dir.name)
        self._patches = list(tensor_seam())
        for p in self._patches:
            p.start()
        self.rows: dict = {}
        self.characters: dict = {}
        for cid, slots in COHERENT.items():
            for emotion, vec in slots.items():
                self.write(f"spk_{cid}", emotion, vec)
        self.write("sarah", "baseline", np.full(DIM, 7.0))
        self.save()
        eb.build(self.root)

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        self._dir.cleanup()

    def write(self, cid: str, emotion: str, vec, **extra) -> str:
        vid = f"{cid}-{emotion}"
        fake_save(self.root / f"{vid}.safetensors", {"e": np.asarray(vec, dtype=np.float64)})
        self.rows[vid] = {"name": cid.title(), "character_id": cid,
                          "emotion": emotion, "created": "2026-07-01T00:00:00",
                          "sample_seconds": 12.0, "lang": "EN", **extra}
        self.characters.setdefault(cid, {"name": cid.title(), "tags": []})
        return vid

    def save(self) -> None:
        (self.root / "_meta.json").write_text(json.dumps(
            {"voices": self.rows, "characters": self.characters}), "utf-8")

    def registry(self) -> dict:
        return af.load_registry(self.root)

    def basis(self) -> eb.Basis:
        basis, reason = eb.load(self.root)
        self.assertIsNone(reason, reason)
        return basis

    def plan(self, demand: dict, *, cap: int = 5, basis: eb.Basis | None = -1):
        if basis == -1:
            basis = self.basis()
        return af.plan(self.registry(), demand, basis, cap=cap)


class PlanTests(_PlanCase):
    def test_the_hottest_missing_slot_is_the_one_picked(self) -> None:
        wanted, _skips = self.plan({"sarah": {"angry": 12, "calm": 40}})
        # `calm` is hotter, but only `angry` has a direction in this basis --
        # the plan is demand ORDERED, not demand DRIVEN off a cliff.
        self.assertEqual([(c.character_id, c.emotion) for c in wanted],
                         [("sarah", "angry")])
        self.assertEqual(wanted[0].demand, 12)

    def test_one_slot_per_character_per_run(self) -> None:
        self.write("bob", "baseline", np.full(DIM, 4.0))
        self.save()
        wanted, _ = self.plan({"sarah": {"angry": 9}, "bob": {"angry": 3}})
        self.assertEqual(len(wanted), 2)
        self.assertEqual([c.character_id for c in wanted], ["sarah", "bob"])

    def test_the_cap_bounds_the_run_and_names_what_it_dropped(self) -> None:
        self.write("bob", "baseline", np.full(DIM, 4.0))
        self.save()
        wanted, skips = self.plan({"sarah": {"angry": 9}, "bob": {"angry": 3}}, cap=1)
        self.assertEqual([c.character_id for c in wanted], ["sarah"])
        self.assertEqual([(s.character_id, s.reason) for s in skips],
                         [("bob", "over this run's cap of 1")])

    def test_a_cap_of_zero_writes_nothing(self) -> None:
        wanted, _ = self.plan({"sarah": {"angry": 9}}, cap=0)
        self.assertEqual(wanted, [])

    def test_the_order_is_deterministic_across_key_order(self) -> None:
        self.write("bob", "baseline", np.full(DIM, 4.0))
        self.save()
        first, _ = self.plan({"sarah": {"angry": 5}, "bob": {"angry": 5}})
        second, _ = self.plan({"bob": {"angry": 5}, "sarah": {"angry": 5}})
        self.assertEqual([c.character_id for c in first],
                         [c.character_id for c in second])
        self.assertEqual([c.character_id for c in first], ["bob", "sarah"])

    def test_a_filled_slot_is_not_refilled(self) -> None:
        self.write("sarah", "angry", np.full(DIM, 8.0))
        self.save()
        wanted, _ = self.plan({"sarah": {"angry": 40}})
        self.assertEqual(wanted, [])

    def test_a_character_with_no_recorded_baseline_is_skipped_by_name(self) -> None:
        self.rows["sarah-baseline"]["origin"] = "derived"
        self.save()
        _wanted, skips = self.plan({"sarah": {"angry": 9}})
        self.assertIn("no recorded baseline", skips[0].reason)

    def test_an_emotion_below_the_coherence_bar_is_skipped_by_name(self) -> None:
        _wanted, skips = self.plan({"sarah": {"calm": 9}})
        self.assertIn("no 'calm' direction", skips[0].reason)

    def test_an_emotion_measured_below_the_quality_bar_is_skipped_by_name(self) -> None:
        eb.write_transfer(self.root, {"angry": {"quality": 0.2, "speakers": 3,
                                                "in_sample": 3}})
        _wanted, skips = self.plan({"sarah": {"angry": 9}})
        self.assertIn("transfer quality", skips[0].reason)

    def test_a_measured_good_emotion_carries_its_number_into_the_plan(self) -> None:
        eb.write_transfer(self.root, {"angry": {"quality": 0.95, "speakers": 3,
                                                "in_sample": 3}})
        wanted, _ = self.plan({"sarah": {"angry": 9}})
        self.assertEqual(wanted[0].quality, 0.95)
        self.assertIn("transfer 0.95", wanted[0].describe())

    def test_an_unmeasured_emotion_is_allowed_and_says_so(self) -> None:
        wanted, _ = self.plan({"sarah": {"angry": 9}})
        self.assertIsNone(wanted[0].quality)
        self.assertIn("unmeasured transfer", wanted[0].describe())

    def test_no_basis_at_all_refuses_every_slot_by_name(self) -> None:
        _wanted, skips = self.plan({"sarah": {"angry": 9}}, basis=None)
        self.assertEqual(skips[0].reason, "no emotion basis is available")

    def test_demand_for_a_character_that_is_not_in_the_registry_is_ignored(self) -> None:
        # Built-ins accrue demand too, and they cannot be extended at all.
        wanted, skips = self.plan({"mary": {"angry": 900}})
        self.assertEqual((wanted, skips), ([], []))

    def test_zero_and_nonsense_counts_are_not_demand(self) -> None:
        wanted, _ = self.plan({"sarah": {"angry": 0, "calm": "lots"}})
        self.assertEqual(wanted, [])

    def test_baseline_is_never_autofilled(self) -> None:
        self.rows.pop("sarah-baseline")
        (self.root / "sarah-baseline.safetensors").unlink()
        self.write("sarah", "calm", np.full(DIM, 7.0))
        self.save()
        wanted, _ = self.plan({"sarah": {"baseline": 50}})
        self.assertEqual(wanted, [])

    def test_a_custom_slot_the_character_declared_is_fillable(self) -> None:
        # ...if the basis learned it. It has not here, so the refusal is the
        # coherence one rather than "not in the palette" -- which is the point:
        # the palette check must not swallow the interesting answer.
        self.characters["sarah"]["custom_emotions"] = ["sarcastic"]
        self.save()
        _wanted, skips = self.plan({"sarah": {"sarcastic": 9}})
        self.assertIn("no 'sarcastic' direction", skips[0].reason)

    def test_an_emotion_outside_the_palette_is_not_invented(self) -> None:
        _wanted, skips = self.plan({"sarah": {"sarcastic": 9}})
        self.assertEqual(skips, [])


class RunTests(_PlanCase):
    def _demand(self, data: dict):
        path = self.root / "emotion_demand.json"
        path.write_text(json.dumps(data), "utf-8")
        return mock.patch.object(demand_mod, "DEMAND_PATH", path)

    def test_a_dry_run_writes_nothing_and_calls_nothing(self) -> None:
        calls = []
        with self._demand({"sarah": {"angry": 9}}):
            af.run(self.root, cap=3, dry_run=True,
                   derive_fn=lambda c: (calls.append(c), ("v1", None))[1])
        self.assertEqual(calls, [])

    def test_a_real_run_derives_the_planned_slots(self) -> None:
        seen = []

        def fake_derive(candidate):
            seen.append((candidate.character_id, candidate.emotion))
            return f"{candidate.character_id}-{candidate.emotion}-abc", None

        with self._demand({"sarah": {"angry": 9}}):
            af.run(self.root, cap=3, derive_fn=fake_derive)
        self.assertEqual(seen, [("sarah", "angry")])

    def test_one_refused_slot_does_not_stop_the_run(self) -> None:
        self.write("bob", "baseline", np.full(DIM, 4.0))
        self.save()
        done = []

        def fake_derive(candidate):
            if candidate.character_id == "sarah":
                return None, "409: the slot is already filled"
            done.append(candidate.character_id)
            return "v-bob", None

        with self._demand({"sarah": {"angry": 9}, "bob": {"angry": 3}}):
            af.run(self.root, cap=3, derive_fn=fake_derive)
        self.assertEqual(done, ["bob"])

    def test_no_basis_is_a_named_skip_for_the_whole_run(self) -> None:
        (self.root / eb.BASIS_JSON).unlink()
        called = []
        with self._demand({"sarah": {"angry": 9}}):
            self.assertEqual(
                af.run(self.root, cap=3, derive_fn=lambda c: called.append(c)), 0)
        self.assertEqual(called, [])

    def test_a_box_that_cannot_read_embeddings_refuses_the_whole_run(self) -> None:
        called = []
        with self._demand({"sarah": {"angry": 9}}), \
             mock.patch.object(res, "load_embedding",
                               side_effect=res.TensorsUnavailable("no safetensors")):
            af.run(self.root, cap=3, derive_fn=lambda c: called.append(c))
        self.assertEqual(called, [])


class EndToEndTests(unittest.TestCase):
    """The tool really calls the endpoint, and the result is really reversible."""

    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.root = Path(self._dir.name) / "voices"
        self.root.mkdir(parents=True)
        self.demand_path = self.root / "emotion_demand.json"
        self._patches = [
            mock.patch.object(vc, "VOICES_DIR", self.root),
            mock.patch.object(vc, "META_PATH", self.root / "_meta.json"),
            mock.patch.object(vc, "_META_LOCK_PATH", self.root / "._meta.lock"),
            mock.patch.object(demand_mod, "DEMAND_PATH", self.demand_path),
            mock.patch.object(res, "save_embedding", fake_save),
            mock.patch.object(res, "load_embedding", fake_load),
        ]
        for p in self._patches:
            p.start()
        vc.invalidate()
        rows: dict = {}
        characters: dict = {}
        for cid, slots in COHERENT.items():
            for emotion, vec in slots.items():
                vid = f"spk_{cid}-{emotion}"
                fake_save(self.root / f"{vid}.safetensors", {"e": np.asarray(vec)})
                rows[vid] = {"name": cid.title(), "character_id": f"spk_{cid}",
                             "emotion": emotion, "created": "2026-07-01T00:00:00",
                             "sample_seconds": 12.0, "lang": "EN"}
                characters[f"spk_{cid}"] = {"name": cid.title(), "tags": []}
        fake_save(self.root / "sarah-baseline.safetensors", {"e": np.full(DIM, 7.0)})
        rows["sarah-baseline"] = {"name": "Sarah", "character_id": "sarah",
                                  "emotion": "baseline", "sample_seconds": 12.0,
                                  "created": "2026-07-01T00:00:00", "lang": "EN"}
        characters["sarah"] = {"name": "Sarah", "tags": []}
        (self.root / "_meta.json").write_text(
            json.dumps({"voices": rows, "characters": characters}), "utf-8")
        vc.invalidate()
        eb.build(self.root)
        self.demand_path.write_text(json.dumps({"sarah": {"angry": 21}}), "utf-8")

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        vc.invalidate()
        self._dir.cleanup()

    def meta(self) -> dict:
        return json.loads((self.root / "_meta.json").read_text("utf-8"))

    def test_the_slot_is_filled_through_the_endpoints_own_path(self) -> None:
        af.run(self.root, cap=3)
        derived = [vid for vid, row in self.meta()["voices"].items()
                   if row.get("origin") == "derived"]
        self.assertEqual(len(derived), 1)
        row = self.meta()["voices"][derived[0]]
        self.assertEqual(row["emotion"], "angry")
        self.assertEqual(row["character_id"], "sarah")
        # ...with everything the hand-made path stamps: provenance, no
        # fabricated recording length, and the unmeasured transfer marker.
        self.assertEqual(row["derived_from"]["source"], "basis")
        self.assertIsNone(row["sample_seconds"])
        self.assertEqual(row["derived_from"]["transfer"]["state"], "unmeasured")
        self.assertTrue((self.root / f"{derived[0]}.safetensors").is_file())

    def test_it_is_reversible_by_the_ordinary_delete(self) -> None:
        af.run(self.root, cap=3)
        vc.invalidate()
        vid = [v for v, r in self.meta()["voices"].items()
               if r.get("origin") == "derived"][0]
        vc.delete_voice(vid)
        self.assertNotIn(vid, self.meta()["voices"])
        self.assertFalse((self.root / f"{vid}.safetensors").is_file())

    def test_a_second_run_finds_nothing_left_to_do(self) -> None:
        af.run(self.root, cap=3)
        vc.invalidate()
        af.run(self.root, cap=3)
        derived = [v for v, r in self.meta()["voices"].items()
                   if r.get("origin") == "derived"]
        self.assertEqual(len(derived), 1)

    def test_a_measured_bad_emotion_is_never_written_by_the_tool(self) -> None:
        eb.write_transfer(self.root, {"angry": {"quality": 0.1, "speakers": 3,
                                                "in_sample": 3}})
        af.run(self.root, cap=3)
        self.assertEqual([v for v, r in self.meta()["voices"].items()
                          if r.get("origin") == "derived"], [])


if __name__ == "__main__":
    unittest.main()
