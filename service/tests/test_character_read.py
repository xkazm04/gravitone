"""GET /v1/characters/{id} — single-character read.

The studio's detail page fetches one character instead of downloading the whole
roster to `.find()` it. These tests prove the endpoint returns exactly the
Character the roster would carry for that id, reports consent per voice, and
surfaces pack-import provenance (imported.from / imported.at) on the Character.

All heavy work (ffmpeg cleanup, pocket_tts export) is mocked — no audio, no
model, no network.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
import service.ingest as ingest
import service.voices as vc
from fastapi.testclient import TestClient

CLIP = b"RIFFfake-wav-bytes\x00\x01\x02\x03"
STATEMENT = "I own this voice or have the speaker's explicit consent to clone it."


class CharacterReadTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.client = TestClient(appmod.app, raise_server_exceptions=False)
        self._patches = [
            mock.patch.object(vc, "VOICES_DIR", self.root),
            mock.patch.object(vc, "META_PATH", self.root / "_meta.json"),
            mock.patch.object(ingest, "VOICES_DIR", self.root),
            mock.patch.object(ingest, "clean_audio", side_effect=self._fake_clean),
            mock.patch.object(vc, "_wav_seconds", return_value=12.0),
            mock.patch.object(vc.subprocess, "run", side_effect=self._fake_export),
        ]
        for p in self._patches:
            p.start()
        vc.invalidate()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        vc.invalidate()
        self._dir.cleanup()

    @staticmethod
    def _fake_clean(src: Path, dst: Path, sr: int = 24000) -> None:
        Path(dst).write_bytes(b"clean")

    @staticmethod
    def _fake_export(cmd, capture_output=False):
        Path(cmd[-1]).write_bytes(b"tensors")
        return mock.Mock(returncode=0, stderr=b"")

    def _clone(self, character="Ada", emotion="baseline"):
        return self.client.post(
            "/v1/voices",
            files={"file": ("clip.wav", CLIP, "audio/wav")},
            data={"character": character, "emotion": emotion,
                  "attested": "true", "statement": STATEMENT},
        )

    # ── built-in ──────────────────────────────────────────────────────────────
    def test_builtin_character_returns_200(self) -> None:
        r = self.client.get("/v1/characters/alba")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["character_id"], "alba")
        self.assertEqual(body["category"], "premade")

    def test_unknown_character_is_404(self) -> None:
        r = self.client.get("/v1/characters/no-such-speaker")
        self.assertEqual(r.status_code, 404)

    def test_matches_the_roster_entry(self) -> None:
        self._clone()
        one = self.client.get("/v1/characters/ada").json()
        roster = self.client.get("/v1/characters").json()
        from_roster = next(c for c in roster if c["character_id"] == "ada")
        self.assertEqual(one, from_roster)

    def test_cloned_voice_reports_consent(self) -> None:
        self._clone()
        body = self.client.get("/v1/characters/ada").json()
        self.assertTrue(all(v["consent"] for v in body["voices"]))

    def test_import_provenance_is_served(self) -> None:
        # Stand in an imported voice directly in the store (a pack import stamps
        # imported:{from,at} onto each voice's meta entry).
        (self.root / "hero-baseline-abc123.safetensors").write_bytes(b"tensors")
        prov = {"from": "orig-hero", "at": "2026-07-01T00:00:00+00:00"}
        import json
        (self.root / "_meta.json").write_text(json.dumps({
            "voices": {"hero-baseline-abc123": {
                "name": "Hero", "character_id": "hero", "emotion": "baseline",
                "lang": "EN", "imported": prov}},
            "characters": {"hero": {"name": "Hero", "tags": []}},
        }), "utf-8")
        vc.invalidate()
        body = self.client.get("/v1/characters/hero").json()
        self.assertEqual(body["imported"], prov)

    def test_non_imported_character_has_null_provenance(self) -> None:
        self._clone()
        body = self.client.get("/v1/characters/ada").json()
        self.assertIsNone(body["imported"])


if __name__ == "__main__":
    unittest.main()
