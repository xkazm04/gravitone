"""A pack import cannot write outside the voices directory.

A .gravichar pack is an UNTRUSTED file — its manifest is written by whoever
built it, the per-voice sha256 entries only check the blobs against that same
manifest, and stock deployments accept unsigned packs (TTS_PACK_SECRET is empty
by default). So every manifest string that reaches a filename or a registry row
must go through `emotions.normalize_emotion` and be REJECTED, not sanitised, on
failure — and every write must re-assert that its resolved destination sits
inside VOICES_DIR.

The whole registry (VOICES_DIR / META_PATH / _META_LOCK_PATH, plus packs.py's
own import-bound VOICES_DIR) is redirected into a temp dir; no test here may
touch the repo's voices/ directory.
"""
from __future__ import annotations

import hashlib
import io
import json
import unittest
import zipfile
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi import HTTPException

from service import packs, voices

BLOB = b"fake-safetensors-payload"
DIGEST = hashlib.sha256(BLOB).hexdigest()


class _Upload:
    """The only bit of UploadFile import_pack touches: `.file.read()`."""

    def __init__(self, data: bytes) -> None:
        self.file = io.BytesIO(data)


def _pack(emotions: list[str], *, name: str = "Imported Person",
          custom: list | None = None) -> bytes:
    voices_entries = []
    for i, emo in enumerate(emotions):
        voices_entries.append({
            "file": f"voices/v{i}.safetensors", "voice_id": f"v{i}", "emotion": emo,
            "sample_seconds": 12.0, "created": "2026-01-01T00:00:00+00:00",
            "sha256": DIGEST,
        })
    manifest = {
        "format": packs.FORMAT,
        "exported_at": "2026-01-01T00:00:00+00:00",
        "generator": "gravitone",
        "character": {"character_id": "source", "name": name, "tags": [],
                      "lang": "EN", "custom_emotions": custom or []},
        "license": "", "creator": "",
        "voices": voices_entries,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as z:
        z.writestr("manifest.json", json.dumps(manifest))
        for entry in voices_entries:
            z.writestr(entry["file"], BLOB)
    return buf.getvalue()


@contextmanager
def _registry():
    """Redirect the entire registry into a temp dir and yield its root."""
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


def _stray(root: Path) -> list[Path]:
    """Anything written anywhere under the temp sandbox, not just VOICES_DIR."""
    return sorted(p for p in root.parent.rglob("*") if p.is_file())


class HostileEmotionsAreRejectedTests(unittest.TestCase):
    def test_parent_traversal_is_rejected_and_writes_nothing(self) -> None:
        # The confirmed escape: '../../../../tmp/evil' resolved OUTSIDE
        # VOICES_DIR and landed the pack's bytes there.
        with _registry() as root:
            with self.assertRaises(HTTPException) as ctx:
                packs.import_pack(file=_Upload(_pack(["../../../../tmp/evil"])), rename="")
            self.assertEqual(400, ctx.exception.status_code)
            self.assertIn("invalid emotion", ctx.exception.detail)
            self.assertEqual([], _stray(root), "a rejected pack left files behind")

    def test_absolute_path_is_rejected(self) -> None:
        for hostile in ("/tmp/evil", "C:\\windows\\temp\\evil"):
            with self.subTest(emotion=hostile), _registry() as root:
                with self.assertRaises(HTTPException) as ctx:
                    packs.import_pack(file=_Upload(_pack([hostile])), rename="")
                self.assertEqual(400, ctx.exception.status_code)
                self.assertEqual([], _stray(root))

    def test_url_encoded_traversal_is_rejected_not_quietly_contained(self) -> None:
        # '..%2f..%2f' does NOT escape the directory, so a substring ban on '..'
        # would "pass" this while still admitting the voice under a name the
        # sender chose. It must be rejected as an invalid emotion outright.
        with _registry() as root:
            with self.assertRaises(HTTPException) as ctx:
                packs.import_pack(file=_Upload(_pack(["..%2f..%2fevil"])), rename="")
            self.assertEqual(400, ctx.exception.status_code)
            self.assertIn("invalid emotion", ctx.exception.detail)
            self.assertEqual([], _stray(root))

    def test_hostile_custom_emotion_in_the_manifest_is_rejected(self) -> None:
        # custom_emotions becomes a registry row and an addressable slot.
        with _registry() as root:
            with self.assertRaises(HTTPException) as ctx:
                packs.import_pack(
                    file=_Upload(_pack(["baseline"], custom=["../../evil"])), rename="")
            self.assertEqual(400, ctx.exception.status_code)
            self.assertIn("custom emotion", ctx.exception.detail)
            self.assertEqual([], _stray(root))

    def test_a_rejected_pack_never_registers_the_character(self) -> None:
        with _registry() as root:
            with self.assertRaises(HTTPException):
                packs.import_pack(file=_Upload(_pack(["baseline", "../evil"])), rename="")
            self.assertEqual({"voices": {}, "characters": {}}, voices._load_meta())
            self.assertEqual([], _stray(root))


class LegitimatePacksStillImportTests(unittest.TestCase):
    def test_custom_emotion_pack_imports_cleanly(self) -> None:
        with _registry() as root:
            character = packs.import_pack(
                file=_Upload(_pack(["baseline", "battle_cry"], custom=["battle_cry"])),
                rename="")
            self.assertEqual("imported-person", character.character_id)
            self.assertEqual(["battle_cry"], character.custom_emotions)
            self.assertEqual({"baseline", "battle_cry"}, set(character.emotions))
            files = sorted(p.name for p in root.glob("*.safetensors"))
            self.assertEqual(2, len(files))
            for f in files:
                self.assertTrue(f.startswith("imported-person-"), f)
            # every written file is inside VOICES_DIR and nowhere else
            self.assertEqual(
                sorted(p for p in _stray(root) if p.suffix == ".safetensors"),
                sorted(root.glob("*.safetensors")))

    def test_display_emotion_spelling_is_normalised_not_rejected(self) -> None:
        # "Battle Cry" is a legitimate spelling of a legal slot — normalize_emotion
        # canonicalises it. Only names that CANNOT be a slot are rejected.
        with _registry() as root:
            character = packs.import_pack(
                file=_Upload(_pack(["Battle Cry"])), rename="")
            self.assertEqual(["battle_cry"], character.emotions)


class ResolvedDestinationIsAssertedTests(unittest.TestCase):
    def test_voice_file_path_refuses_to_leave_the_directory(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            self.assertEqual(root / "ok.safetensors",
                             voices.voice_file_path("ok", root))
            for hostile in ("../escape", "sub/nested", "/abs/escape"):
                with self.subTest(voice_id=hostile):
                    with self.assertRaises(ValueError):
                        voices.voice_file_path(hostile, root)


class IngestCommitBoundaryTests(unittest.TestCase):
    """The same class of hole at the ingest route: CommitReq.emotions is
    client-supplied and flows into work_dir/stem_{emo}.wav and the destination."""

    def _commit(self, **kw):
        from service import ingest_api
        req = ingest_api.CommitReq(
            character="Someone", attested=True, statement="I own this voice", **kw)
        return ingest_api.commit("job-does-not-exist", req)

    def test_hostile_emotion_is_rejected_at_the_route(self) -> None:
        for hostile in ("../../../../tmp/evil", "/tmp/evil", "..%2f..%2fevil", ""):
            with self.subTest(emotion=hostile):
                with self.assertRaises(HTTPException) as ctx:
                    self._commit(emotions=["baseline", hostile])
                self.assertEqual(400, ctx.exception.status_code)

    def test_hostile_character_id_is_rejected_at_the_route(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            self._commit(emotions=["baseline"], character_id="../../evil")
        self.assertEqual(400, ctx.exception.status_code)
        self.assertIn("character_id", ctx.exception.detail)

    def test_a_valid_request_gets_past_validation(self) -> None:
        # Reaches the job lookup (the job is absent -> expired), proving the
        # boundary check did not reject a legitimate commit.
        from starlette.responses import JSONResponse
        out = self._commit(emotions=["baseline", "battle_cry"], character_id="someone")
        self.assertIsInstance(out, JSONResponse)


if __name__ == "__main__":
    unittest.main()
