"""`voices.remove_voices` — the rollback primitive for a half-finished clone.

The dangerous failure mode is over-deletion: a cancelled *extend* must leave
the character's pre-existing Voices completely alone.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service.tests import fake_engine  # installs shims — must precede app import

import service.voices as voices


class RemoveVoicesTests(unittest.TestCase):
    def setUp(self) -> None:
        self._td = TemporaryDirectory()
        self.root = Path(self._td.name)
        self._patches = [
            mock.patch.object(voices, "VOICES_DIR", self.root),
            mock.patch.object(voices, "META_PATH", self.root / "_meta.json"),
            mock.patch.object(voices, "_META_LOCK_PATH", self.root / "._meta.lock"),
        ]
        for p in self._patches:
            p.start()
        voices.invalidate()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        self._td.cleanup()
        voices.invalidate()

    def _seed(self, meta: dict) -> None:
        (self.root / "_meta.json").write_text(json.dumps(meta), "utf-8")
        for vid in meta.get("voices", {}):
            (self.root / f"{vid}.safetensors").write_bytes(b"emb")

    def _meta(self) -> dict:
        return json.loads((self.root / "_meta.json").read_text("utf-8"))

    def test_removes_entries_and_embedding_files(self) -> None:
        self._seed({"voices": {"ada-happy": {"character_id": "ada", "emotion": "happy"}},
                    "characters": {"ada": {"name": "Ada", "tags": []}}})
        removed = voices.remove_voices(["ada-happy"])
        self.assertEqual(removed, ["ada-happy"])
        self.assertEqual(self._meta()["voices"], {})
        self.assertFalse((self.root / "ada-happy.safetensors").exists())

    def test_drops_a_character_it_emptied(self) -> None:
        # A fresh clone that was cancelled leaves no voices — the character row
        # it created would be a ghost in the roster.
        self._seed({"voices": {"ada-happy": {"character_id": "ada", "emotion": "happy"}},
                    "characters": {"ada": {"name": "Ada", "tags": []}}})
        voices.remove_voices(["ada-happy"])
        self.assertNotIn("ada", self._meta()["characters"])

    def test_cancelled_EXTEND_keeps_pre_existing_voices_and_character(self) -> None:
        # The over-deletion guard: only the ids this commit created go away.
        self._seed({
            "voices": {
                "ada-baseline": {"character_id": "ada", "emotion": "baseline"},
                "ada-happy": {"character_id": "ada", "emotion": "happy"},
            },
            "characters": {"ada": {"name": "Ada", "tags": []}},
        })
        voices.remove_voices(["ada-happy"])           # only the new one
        meta = self._meta()
        self.assertIn("ada-baseline", meta["voices"])
        self.assertNotIn("ada-happy", meta["voices"])
        self.assertIn("ada", meta["characters"])      # character survives
        self.assertTrue((self.root / "ada-baseline.safetensors").exists())

    def test_only_touches_the_named_character(self) -> None:
        self._seed({
            "voices": {
                "ada-happy": {"character_id": "ada", "emotion": "happy"},
                "bo-happy": {"character_id": "bo", "emotion": "happy"},
            },
            "characters": {"ada": {"name": "Ada", "tags": []},
                           "bo": {"name": "Bo", "tags": []}},
        })
        voices.remove_voices(["ada-happy"])
        meta = self._meta()
        self.assertIn("bo-happy", meta["voices"])
        self.assertIn("bo", meta["characters"])

    def test_unknown_ids_are_ignored(self) -> None:
        self._seed({"voices": {}, "characters": {}})
        self.assertEqual(voices.remove_voices(["nope"]), [])

    def test_empty_input_is_a_noop(self) -> None:
        self._seed({"voices": {"ada-happy": {"character_id": "ada"}},
                    "characters": {"ada": {"name": "Ada"}}})
        self.assertEqual(voices.remove_voices([]), [])
        self.assertIn("ada-happy", self._meta()["voices"])

    def test_missing_embedding_file_does_not_raise(self) -> None:
        # Teardown path: converge on "not registered", don't assert what was there.
        self._seed({"voices": {"ada-happy": {"character_id": "ada", "emotion": "happy"}},
                    "characters": {"ada": {"name": "Ada"}}})
        (self.root / "ada-happy.safetensors").unlink()
        self.assertEqual(voices.remove_voices(["ada-happy"]), ["ada-happy"])


if __name__ == "__main__":
    unittest.main()
