"""What a .gravichar pack carries about each slot -- and what it may never launder.

A pack is how a Character LEAVES an install, and everything the receiving
instance can ever know about a slot has to survive that trip. Four registry
fields are load-bearing here and every one of them was being dropped on export:

  * `origin` -- a computed slot arriving as a RECORDING is consent laundering by
    omission: the far instance would show it as a performance somebody gave.
  * `derived_from` -- where a computed slot came from, including the transfer
    quality it was licensed by.
  * `fidelity` / `prosody` -- the measured facts. A bought Character should be
    as inspectable as a locally cloned one.

The guard runs BOTH ways: what export writes, what import stores, and the rule
that no manifest can promote a derived slot to a recorded one.
"""
from __future__ import annotations

import json
import unittest
import zipfile
from io import BytesIO
from unittest import mock

from service import packs, voices
from service.tests.test_pack_safety import BLOB, _Upload, _registry

FIDELITY = {"clipping": 0.0, "noise_floor_db": -62.0, "effective_seconds": 11.2}
PROSODY = {"f0_mean": 198.4, "f0_sd": 31.2, "energy_rms": 0.09,
           "rate_proxy": 4.1, "spectral_tilt": -9.8, "version": 1}
DERIVED_FROM = {"source": "basis", "donor": None, "emotion": "angry",
                "from_voice_id": "seller-baseline", "basis_version": 1,
                "alpha": 2.5, "transfer": {"quality": 0.82, "speakers": 3,
                                           "in_sample": 2, "version": 1},
                "at": "2026-07-30T10:00:00"}


def _seed(root, rows: dict) -> None:
    """Write one embedding + registry row per slot for character `seller`."""
    meta = {"voices": {}, "characters": {"seller": {"name": "Seller", "tags": []}}}
    for vid, row in rows.items():
        (root / f"{vid}.safetensors").write_bytes(BLOB)
        meta["voices"][vid] = {"name": "Seller", "character_id": "seller",
                               "lang": "EN", "created": "2026-07-01T00:00:00",
                               **row}
    (root / "_meta.json").write_text(json.dumps(meta), "utf-8")
    voices.invalidate()


BASE_ROWS = {
    "seller-baseline": {"emotion": "baseline", "sample_seconds": 12.0,
                        "fidelity": FIDELITY, "prosody": PROSODY},
    "seller-angry": {"emotion": "angry", "sample_seconds": None,
                     "origin": "derived", "derived_from": DERIVED_FROM,
                     "prosody": PROSODY},
}


def _manifest(zip_bytes: bytes) -> dict:
    with zipfile.ZipFile(BytesIO(zip_bytes)) as z:
        return json.loads(z.read("manifest.json"))


def _entries(zip_bytes: bytes) -> dict:
    return {v["emotion"]: v for v in _manifest(zip_bytes)["voices"]}


class ExportCarriesEveryMeasuredFieldTests(unittest.TestCase):
    def test_a_derived_slot_leaves_labelled_as_derived(self) -> None:
        with _registry() as root:
            _seed(root, BASE_ROWS)
            entry = _entries(packs.export_pack("seller").body)["angry"]
        self.assertEqual(entry["origin"], "derived")
        self.assertEqual(entry["derived_from"], DERIVED_FROM)
        # ...including the quality number the derive was licensed by.
        self.assertEqual(entry["derived_from"]["transfer"]["quality"], 0.82)

    def test_the_measured_facts_travel(self) -> None:
        with _registry() as root:
            _seed(root, BASE_ROWS)
            entry = _entries(packs.export_pack("seller").body)["baseline"]
        self.assertEqual(entry["fidelity"], FIDELITY)
        self.assertEqual(entry["prosody"], PROSODY)

    def test_a_recorded_slot_says_nothing_it_cannot_back_up(self) -> None:
        # No `origin` key at all on a recording, no `derived_from`, and no
        # zeroed measurement objects where nothing was measured.
        with _registry() as root:
            _seed(root, {"seller-baseline": {"emotion": "baseline",
                                             "sample_seconds": 12.0}})
            entry = _entries(packs.export_pack("seller").body)["baseline"]
        for absent in ("origin", "derived_from", "fidelity", "prosody"):
            self.assertNotIn(absent, entry)


class ImportKeepsWhatTravelledTests(unittest.TestCase):
    def _round_trip(self) -> dict:
        """Export from one install, import into a fresh one, return its rows."""
        with _registry() as root:
            _seed(root, BASE_ROWS)
            blob = packs.export_pack("seller").body
        with _registry() as root:
            packs.import_pack(file=_Upload(blob), rename="Buyer Person")
            meta = json.loads((root / "_meta.json").read_text("utf-8"))
        return {row["emotion"]: row for row in meta["voices"].values()}

    def test_the_derived_slot_is_still_derived_on_the_far_side(self) -> None:
        rows = self._round_trip()
        self.assertEqual(rows["angry"]["origin"], "derived")
        self.assertEqual(rows["angry"]["derived_from"], DERIVED_FROM)

    def test_the_measured_facts_survive_the_trip(self) -> None:
        rows = self._round_trip()
        self.assertEqual(rows["baseline"]["fidelity"], FIDELITY)
        self.assertEqual(rows["baseline"]["prosody"], PROSODY)

    def test_the_recorded_slot_stays_recorded(self) -> None:
        rows = self._round_trip()
        self.assertNotIn("origin", rows["baseline"])

    def test_the_roster_reports_the_imported_origin(self) -> None:
        with _registry() as root:
            _seed(root, BASE_ROWS)
            blob = packs.export_pack("seller").body
        with _registry():
            imported = packs.import_pack(file=_Upload(blob), rename="Buyer Person")
            by_emotion = {v.emotion: v for v in imported.voices}
        self.assertEqual(by_emotion["angry"].origin, "derived")
        self.assertEqual(by_emotion["baseline"].origin, "recorded")


class ConsentCannotBeLaunderedTests(unittest.TestCase):
    """A pack is written by whoever built it. It does not get to promote a slot."""

    def _pack(self, voice_entry: dict) -> bytes:
        import hashlib

        entry = {"file": "voices/v0.safetensors", "voice_id": "v0",
                 "emotion": "angry", "created": "2026-01-01T00:00:00",
                 "sha256": hashlib.sha256(BLOB).hexdigest(), **voice_entry}
        manifest = {"format": packs.FORMAT, "exported_at": "2026-01-01T00:00:00",
                    "generator": "gravitone",
                    "character": {"character_id": "source", "name": "Sender",
                                  "tags": [], "lang": "EN", "custom_emotions": []},
                    "license": "", "creator": "", "voices": [entry]}
        buf = BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as z:
            z.writestr("manifest.json", json.dumps(manifest))
            z.writestr(entry["file"], BLOB)
        return buf.getvalue()

    def _import(self, voice_entry: dict) -> dict:
        with _registry() as root:
            packs.import_pack(file=_Upload(self._pack(voice_entry)), rename="Buyer")
            meta = json.loads((root / "_meta.json").read_text("utf-8"))
        return next(iter(meta["voices"].values()))

    def test_a_derived_slot_claiming_to_be_recorded_stays_derived(self) -> None:
        row = self._import({"origin": "recorded", "derived_from": DERIVED_FROM,
                            "sample_seconds": 12.0})
        self.assertEqual(row["origin"], "derived")
        # ...and it does not get to claim a recording length either.
        self.assertIsNone(row["sample_seconds"])

    def test_dropping_the_origin_field_does_not_promote_it(self) -> None:
        row = self._import({"derived_from": DERIVED_FROM})
        self.assertEqual(row["origin"], "derived")

    def test_an_unknown_origin_value_is_not_a_third_state(self) -> None:
        row = self._import({"origin": "sort-of-recorded"})
        self.assertNotIn("origin", row)  # reads as recorded, the honest default

    def test_a_malformed_measurement_is_rejected_not_quietly_dropped(self) -> None:
        with _registry():
            with self.assertRaises(Exception) as ctx:
                packs.import_pack(file=_Upload(self._pack({"fidelity": "great"})),
                                  rename="Buyer")
        self.assertIn("malformed fidelity", str(ctx.exception.detail))

    def test_a_rejected_pack_writes_nothing(self) -> None:
        with _registry() as root:
            with self.assertRaises(Exception):
                packs.import_pack(file=_Upload(self._pack({"prosody": [1, 2]})),
                                  rename="Buyer")
            self.assertEqual(list(root.glob("*.safetensors")), [])


if __name__ == "__main__":
    unittest.main()
