"""A corrupt registry is never quietly replaced with an empty one.

Three failure modes that all ended with the registry and the filesystem lying
to each other, and the fixes that are pinned here:

  * a corrupt ``_meta.json`` used to read as an EMPTY registry — every Character
    silently vanished — and the next mutation saved that empty skeleton over the
    damaged file. It now raises `voices.RegistryCorrupt` (503) and the bytes on
    disk are left byte-identical. No automatic repair, by design.
  * ``create_voice`` used to export the embedding into VOICES_DIR BEFORE
    committing the registry row, and the roster is glob-driven, so a failed
    commit stranded a phantom Character slugged from the voice id. The export is
    staged in the temp dir and moved in AFTER the commit; a failed move retracts
    the row.
  * deletion popped registry rows and unlinked files afterwards (or unlinked
    inside the mutation and raised mid-loop). Both orders could end with the
    registry claiming files that were gone, or a phantom resurrected from a file
    that refused to unlink. `_unlink_then_forget` is now the one ordering: file
    first, row only if the file really went away.

Every path is redirected into a temp dir (VOICES_DIR, META_PATH AND the
import-bound _META_LOCK_PATH); nothing here touches the repo's voices/ dir. All
subprocesses are mocked — no ffmpeg, no model.
"""
from __future__ import annotations

import io
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi import HTTPException

import service.ingest as ingest
import service.voices as voices
from service import export_stems
from service.tests.test_clone_path import fake_export_child

CLIP = b"RIFFfake-wav-bytes"
STATEMENT = "I own this voice."


class _RegistryCase(unittest.TestCase):
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
        voices.invalidate()
        self._td.cleanup()

    def _seed(self, meta: dict, *, files: bool = True) -> None:
        (self.root / "_meta.json").write_text(json.dumps(meta), "utf-8")
        if files:
            for vid in meta.get("voices", {}):
                (self.root / f"{vid}.safetensors").write_bytes(b"emb")
        voices.invalidate()

    def _meta(self) -> dict:
        return json.loads((self.root / "_meta.json").read_text("utf-8"))


class CorruptRegistryTests(_RegistryCase):
    CORRUPT = '{"voices": {"ada-happy": {"character_id": "ada"'  # truncated

    def _corrupt(self) -> Path:
        p = self.root / "_meta.json"
        p.write_text(self.CORRUPT, "utf-8")
        (self.root / "ada-happy.safetensors").write_bytes(b"emb")
        voices.invalidate()
        return p

    def test_reading_a_corrupt_registry_raises_503_instead_of_emptying_it(self) -> None:
        self._corrupt()
        with self.assertRaises(voices.RegistryCorrupt) as ctx:
            voices._load_meta()
        self.assertEqual(503, ctx.exception.status_code)
        self.assertIn("left untouched", ctx.exception.detail)

    def test_the_roster_is_not_silently_empty(self) -> None:
        self._corrupt()
        with self.assertRaises(voices.RegistryCorrupt):
            voices.list_characters()

    def test_a_mutation_leaves_the_damaged_file_byte_identical(self) -> None:
        # The permanent-loss step: load empty skeleton -> mutate -> save over the
        # real file. The mutation must never even run.
        path = self._corrupt()
        before = path.read_bytes()
        ran = []
        with self.assertRaises(voices.RegistryCorrupt):
            voices.mutate_meta(lambda meta: ran.append(meta))
        self.assertEqual([], ran)
        self.assertEqual(before, path.read_bytes())

    def test_nothing_is_repaired_automatically(self) -> None:
        path = self._corrupt()
        for _ in range(3):
            with self.assertRaises(voices.RegistryCorrupt):
                voices.list_characters()
        self.assertEqual(self.CORRUPT, path.read_text("utf-8"))


class CloneCommitOrderingTests(_RegistryCase):
    """create_voice: nothing is left behind when the commit or the move fails."""

    def _create(self, **kw):
        class _Upload:
            filename = "clip.wav"

            def __init__(self, data: bytes) -> None:
                self.file = io.BytesIO(data)

        def _fake_clean(src, dst, sr=24000):
            Path(dst).write_bytes(b"clean")

        with mock.patch.object(ingest, "clean_audio", side_effect=_fake_clean), \
             mock.patch.object(voices, "_wav_seconds", return_value=12.0), \
             mock.patch.object(export_stems.subprocess, "run",
                               side_effect=fake_export_child()):
            return voices.create_voice(
                file=_Upload(CLIP), character="Ada", emotion="baseline", tags="",
                attested="true", statement=STATEMENT, **kw)

    def test_happy_path_registers_the_voice_and_its_file(self) -> None:
        v = self._create()
        self.assertTrue((self.root / f"{v.voice_id}.safetensors").is_file())
        self.assertIn(v.voice_id, self._meta()["voices"])

    def test_a_failed_commit_strands_no_phantom_character(self) -> None:
        # An OSError in _save_meta (or a file_lock TimeoutError) after the export.
        with mock.patch.object(voices, "mutate_meta", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self._create()
        self.assertEqual([], list(self.root.glob("*.safetensors")))
        self.assertEqual([], [c for c in voices.list_characters() if c.category == "cloned"])

    def test_a_failed_publish_retracts_the_registry_row(self) -> None:
        with mock.patch.object(voices.shutil, "move", side_effect=OSError("cross-device")):
            with self.assertRaises(HTTPException) as ctx:
                self._create()
        self.assertEqual(500, ctx.exception.status_code)
        self.assertEqual({}, self._meta()["voices"])
        self.assertEqual([], list(self.root.glob("*.safetensors")))

    def test_a_duplicate_slot_refusal_leaves_no_file(self) -> None:
        v = self._create()
        # The under-lock re-check refuses the second clone of the same slot.
        with mock.patch.object(voices, "emotion_map", return_value={}):
            with self.assertRaises(HTTPException) as ctx:
                self._create()
        self.assertEqual(409, ctx.exception.status_code)
        self.assertEqual([v.voice_id], [p.stem for p in self.root.glob("*.safetensors")])


def _unlink_refusing(*names: str):
    """Patch Path.unlink so the named files refuse to be deleted (EACCES)."""
    wanted = set(names)

    def _fake(self, missing_ok=False):
        if self.name in wanted:
            raise OSError(13, "in use by another process")
        try:
            os.unlink(self)
        except FileNotFoundError:
            if not missing_ok:
                raise

    return mock.patch.object(Path, "unlink", _fake)


class DeleteOrderingTests(_RegistryCase):
    def test_deleting_a_voice_whose_file_is_already_gone_succeeds(self) -> None:
        # The registry-only ghost: 404'ing on the missing FILE made it
        # impossible to remove through the API at all.
        self._seed({"voices": {"ada-happy": {"character_id": "ada", "emotion": "happy"}},
                    "characters": {"ada": {"name": "Ada"}}}, files=False)
        voices.delete_voice("ada-happy")
        self.assertEqual({}, self._meta()["voices"])

    def test_deleting_an_orphan_embedding_succeeds(self) -> None:
        # A file with no registry row is a phantom Character in the roster.
        self._seed({"voices": {}, "characters": {}})
        (self.root / "ada-happy.safetensors").write_bytes(b"emb")
        voices.invalidate()
        self.assertIn("ada-happy", [c.character_id for c in voices.list_characters()])
        voices.delete_voice("ada-happy")
        self.assertEqual([], list(self.root.glob("*.safetensors")))
        self.assertNotIn("ada-happy", [c.character_id for c in voices.list_characters()])

    def test_an_unknown_voice_is_still_a_404(self) -> None:
        self._seed({"voices": {}, "characters": {}})
        with self.assertRaises(HTTPException) as ctx:
            voices.delete_voice("nope")
        self.assertEqual(404, ctx.exception.status_code)

    def test_an_undeletable_file_leaves_the_registry_untouched(self) -> None:
        self._seed({"voices": {"ada-happy": {"character_id": "ada", "emotion": "happy"}},
                    "characters": {"ada": {"name": "Ada"}}})
        with _unlink_refusing("ada-happy.safetensors"):
            with self.assertRaises(HTTPException) as ctx:
                voices.delete_voice("ada-happy")
        self.assertEqual(500, ctx.exception.status_code)
        self.assertIn("ada-happy", self._meta()["voices"])       # still a real Voice
        self.assertTrue((self.root / "ada-happy.safetensors").is_file())

    def test_character_delete_commits_the_half_that_worked(self) -> None:
        self._seed({
            "voices": {
                "ada-happy": {"character_id": "ada", "emotion": "happy"},
                "ada-sad": {"character_id": "ada", "emotion": "sad"},
            },
            "characters": {"ada": {"name": "Ada"}},
        })
        with _unlink_refusing("ada-sad.safetensors"):
            with self.assertRaises(HTTPException) as ctx:
                voices.delete_character("ada")
        self.assertEqual(500, ctx.exception.status_code)
        meta = self._meta()
        # Registry and filesystem agree: the file that went away lost its row,
        # the file that survived kept one (and so did its character).
        self.assertNotIn("ada-happy", meta["voices"])
        self.assertIn("ada-sad", meta["voices"])
        self.assertIn("ada", meta["characters"])
        self.assertEqual(["ada-sad"], [p.stem for p in self.root.glob("*.safetensors")])

    def test_rollback_does_not_resurrect_a_phantom(self) -> None:
        # remove_voices used to pop the row first: a file that refused to unlink
        # came back as a phantom Character the caller thought it had rolled back.
        self._seed({"voices": {"ada-happy": {"character_id": "ada", "emotion": "happy"}},
                    "characters": {"ada": {"name": "Ada"}}})
        with _unlink_refusing("ada-happy.safetensors"):
            removed = voices.remove_voices(["ada-happy"])
        self.assertEqual([], removed)                            # honest report
        self.assertIn("ada-happy", self._meta()["voices"])       # not a phantom


if __name__ == "__main__":
    unittest.main()
