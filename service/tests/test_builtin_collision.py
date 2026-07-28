"""Cloning a voice named "Mary" must not make it vanish.

Built-in character ids are ordinary first names (mary, jane, paul…), so a user
WILL pick one. The rule, identical on every creation path:

  * refuse up front — `voices.reject_builtin_collision` (create_voice AND
    import_pack), before any work, so no orphan embedding is left behind;
  * a cloned Character ALREADY on disk wins in the roster — `_build_characters`
    no longer overwrites it with the built-in, so an install that predates the
    check can still see and delete it.

The registry is redirected into a temp dir throughout (including packs.py's own
import-bound VOICES_DIR); nothing here touches the repo's voices/ directory.
"""
from __future__ import annotations

import json
import unittest
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi import HTTPException

from service import packs, voices
from service.tests.test_pack_safety import _Upload, _pack


@contextmanager
def _registry():
    with TemporaryDirectory() as td:
        root = Path(td) / "voices"
        root.mkdir(parents=True)
        with mock.patch.object(voices, "VOICES_DIR", root), \
             mock.patch.object(voices, "META_PATH", root / "_meta.json"), \
             mock.patch.object(voices, "_META_LOCK_PATH", root / "._meta.lock"), \
             mock.patch.object(packs, "VOICES_DIR", root):
            voices.invalidate()
            yield root
            voices.invalidate()


def _seed_legacy_mary(root: Path) -> str:
    """A colliding clone as a live install would already have it on disk."""
    voice_id = "mary-baseline-aa11bb"
    (root / f"{voice_id}.safetensors").write_bytes(b"legacy-embedding")
    (root / "_meta.json").write_text(json.dumps({
        "voices": {voice_id: {"name": "Mary", "character_id": "mary",
                              "emotion": "baseline", "created": "2026-01-01T00:00:00+00:00",
                              "sample_seconds": 14.0, "lang": "EN"}},
        "characters": {"mary": {"name": "Mary", "tags": []}},
    }), "utf-8")
    voices.invalidate()
    return voice_id


class NewCollisionsAreRefusedTests(unittest.TestCase):
    def test_create_voice_refuses_a_builtin_name_and_leaves_no_file(self) -> None:
        with _registry() as root:
            with self.assertRaises(HTTPException) as ctx:
                voices.create_voice(
                    file=_Upload(b"never read"), character="Mary",
                    emotion="baseline", tags="", attested="true",
                    statement="I own this voice")
            self.assertEqual(409, ctx.exception.status_code)
            self.assertIn("mary", ctx.exception.detail)
            self.assertIn("built-in", ctx.exception.detail)
            self.assertEqual([], list(root.glob("*.safetensors")))

    def test_import_pack_refuses_a_builtin_name_the_same_way(self) -> None:
        with _registry() as root:
            with self.assertRaises(HTTPException) as ctx:
                packs.import_pack(
                    file=_Upload(_pack(["baseline"], name="Mary")), rename="")
            self.assertEqual(409, ctx.exception.status_code)
            self.assertIn("built-in", ctx.exception.detail)
            self.assertEqual([], list(root.glob("*.safetensors")))
            self.assertEqual({"voices": {}, "characters": {}}, voices._load_meta())

    def test_rename_is_the_escape_hatch_for_an_import(self) -> None:
        with _registry() as root:
            character = packs.import_pack(
                file=_Upload(_pack(["baseline"], name="Mary")), rename="Mary Q")
            self.assertEqual("mary-q", character.character_id)
            self.assertEqual(1, len(list(root.glob("*.safetensors"))))

    def test_a_non_colliding_name_is_untouched(self) -> None:
        with _registry():
            voices.reject_builtin_collision("mary-q", "Mary Q")  # does not raise


class AnExistingCollisionStaysVisibleTests(unittest.TestCase):
    def test_a_legacy_cloned_mary_is_in_the_roster_not_erased(self) -> None:
        with _registry() as root:
            voice_id = _seed_legacy_mary(root)
            mary = voices.find_character("mary")
            self.assertIsNotNone(mary, "the cloned Character vanished from the roster")
            self.assertEqual("cloned", mary.category)
            self.assertEqual([voice_id], [v.voice_id for v in mary.voices])
            # exactly one 'mary' — the built-in did not also slip in
            self.assertEqual(
                1, sum(1 for c in voices.list_characters() if c.character_id == "mary"))

    def test_a_legacy_cloned_mary_can_be_deleted(self) -> None:
        with _registry() as root:
            voice_id = _seed_legacy_mary(root)
            self.assertEqual([voice_id], voices.remove_voices([voice_id]))
            voices.invalidate()
            # once the clone is gone the built-in returns
            mary = voices.find_character("mary")
            self.assertIsNotNone(mary)
            self.assertEqual("premade", mary.category)

    def test_uncollided_builtins_are_all_still_present(self) -> None:
        with _registry() as root:
            _seed_legacy_mary(root)
            roster = {c.character_id for c in voices.list_characters()}
            for vid, _lang in voices.BUILTIN:
                self.assertIn(vid, roster)


if __name__ == "__main__":
    unittest.main()
