"""Consent receipts for direct API clones (POST /v1/voices).

The direct clone endpoint (`service.voices.create_voice`) now requires an
ownership attestation and stamps the SAME consent-receipt shape ingest does
({consented_at, clip_sha256, statement}) into the Voice's meta entry. These
tests prove:

  * a clone without a valid attestation is refused with 422 + a clear message;
  * a clone WITH attestation writes the receipt (correct shape + sha256 of the
    exact uploaded bytes) and reports consent=True on the Voice model.

All heavy work (ffmpeg cleanup, pocket_tts export subprocess) is mocked — no
audio, no model, no network.
"""
from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
import service.ingest as ingest
import service.voices as vc
from fastapi.testclient import TestClient

CLIP = b"RIFFfake-wav-bytes-for-sha256-and-upload\x00\x01\x02\x03"
STATEMENT = "I own this voice or have the speaker's explicit consent to clone it."


class DirectCloneConsentTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.client = TestClient(appmod.app, raise_server_exceptions=False)
        # Point the registry + voices store at an isolated temp dir and make the
        # export subprocess + ffmpeg cleanup no-ops that produce the expected
        # artefacts, so the endpoint runs end-to-end without a model.
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
        vc.invalidate()  # drop any cached characters keyed on the real paths

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        vc.invalidate()
        self._dir.cleanup()

    @staticmethod
    def _fake_clean(src: Path, dst: Path, sr: int = 24000) -> None:
        Path(dst).write_bytes(b"clean")  # a wav stand-in; _wav_seconds is mocked

    @staticmethod
    def _fake_export(cmd, capture_output=False):
        Path(cmd[-1]).write_bytes(b"tensors")  # the export writes the safetensors
        return mock.Mock(returncode=0, stderr=b"")

    def _post(self, **data):
        return self.client.post(
            "/v1/voices",
            files={"file": ("clip.wav", CLIP, "audio/wav")},
            data={"character": "Ada", "emotion": "baseline", **data},
        )

    # ── attestation gate ──────────────────────────────────────────────────────
    def test_missing_attestation_is_422(self) -> None:
        r = self._post(statement=STATEMENT)  # attested absent → not "true"
        self.assertEqual(r.status_code, 422)
        self.assertIn("attestation", r.json()["detail"].lower())

    def test_attested_false_is_422(self) -> None:
        r = self._post(attested="false", statement=STATEMENT)
        self.assertEqual(r.status_code, 422)

    def test_attested_but_blank_statement_is_422(self) -> None:
        r = self._post(attested="true", statement="   ")
        self.assertEqual(r.status_code, 422)

    def test_no_voice_written_when_refused(self) -> None:
        self._post(statement=STATEMENT)
        self.assertFalse(list(self.root.glob("*.safetensors")))
        self.assertFalse((self.root / "_meta.json").exists())

    # ── receipt on success ────────────────────────────────────────────────────
    def test_clone_stamps_consent_receipt(self) -> None:
        r = self._post(attested="true", statement=STATEMENT)
        self.assertEqual(r.status_code, 201, r.text)
        body = r.json()
        # The Voice model reports consent=True afterwards.
        self.assertTrue(body["consent"])
        voice_id = body["voice_id"]

        meta = json.loads((self.root / "_meta.json").read_text("utf-8"))
        entry = meta["voices"][voice_id]
        receipt = entry["consent"]
        # Exact shape ingest stamps: consented_at, clip_sha256, statement.
        self.assertEqual(set(receipt), {"consented_at", "clip_sha256", "statement"})
        self.assertEqual(receipt["statement"], STATEMENT)
        self.assertEqual(receipt["clip_sha256"], hashlib.sha256(CLIP).hexdigest())
        self.assertTrue(receipt["consented_at"])

    def test_statement_is_trimmed(self) -> None:
        r = self._post(attested="TRUE", statement=f"  {STATEMENT}  ")
        self.assertEqual(r.status_code, 201, r.text)
        meta = json.loads((self.root / "_meta.json").read_text("utf-8"))
        entry = meta["voices"][r.json()["voice_id"]]
        self.assertEqual(entry["consent"]["statement"], STATEMENT)


if __name__ == "__main__":
    unittest.main()
