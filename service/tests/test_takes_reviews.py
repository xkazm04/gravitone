"""Takes + review sets + pack import — first error-path coverage for the two
routers that had none. Store dirs are pointed at a temp dir per test, so
nothing touches the real voices/takes data."""
from __future__ import annotations

import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
import service.takes as takes
from fastapi.testclient import TestClient

WAV = b"RIFF" + b"\x00" * 40  # enough to pass the RIFF sniff


class _TakesBase(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        root = Path(self._td.name)
        self._orig = (takes.TAKES_DIR, takes.REVIEWS_DIR)
        takes.TAKES_DIR = root / "takes"
        takes.REVIEWS_DIR = root / "reviews"
        self.client = TestClient(appmod.app, raise_server_exceptions=False)

    def tearDown(self) -> None:
        takes.TAKES_DIR, takes.REVIEWS_DIR = self._orig
        self._td.cleanup()

    def _create_take(self, text: str = "Hello there.") -> str:
        resp = self.client.post(
            "/v1/takes",
            files={"file": ("t.wav", WAV, "audio/wav")},
            data={"meta": f'{{"text": "{text}", "segments": [], '
                          f'"character_id": "sarah"}}'},
        )
        self.assertEqual(resp.status_code, 201)
        return resp.json()["take_id"]


class TakesErrorTests(_TakesBase):
    def test_bad_meta_json_is_400(self) -> None:
        resp = self.client.post(
            "/v1/takes", files={"file": ("t.wav", WAV, "audio/wav")},
            data={"meta": "not json"})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("JSON", resp.json()["detail"])

    def test_non_wav_audio_is_400(self) -> None:
        resp = self.client.post(
            "/v1/takes", files={"file": ("t.mp3", b"ID3\x04junk", "audio/mpeg")},
            data={"meta": '{"text": "x", "segments": []}'})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("wav", resp.json()["detail"])

    def test_unknown_take_is_404(self) -> None:
        resp = self.client.get("/v1/takes/deadbeef00")
        self.assertEqual(resp.status_code, 404)


class ReviewsErrorTests(_TakesBase):
    def test_review_of_unknown_take_is_404(self) -> None:
        resp = self.client.post(
            "/v1/reviews", json={"take_ids": ["nosuch0001", "nosuch0002"]})
        self.assertEqual(resp.status_code, 404)

    def test_pick_flow_first_pick_wins(self) -> None:
        t1, t2 = self._create_take("A."), self._create_take("A.")
        review_id = self.client.post(
            "/v1/reviews", json={"take_ids": [t1, t2]}).json()["review_id"]

        outside = self.client.post(
            f"/v1/reviews/{review_id}/pick", json={"take_id": "intruder001"})
        self.assertEqual(outside.status_code, 400)

        first = self.client.post(
            f"/v1/reviews/{review_id}/pick", json={"take_id": t1})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["take_id"], t1)

        # A decided review is final — the double-decide race lands on 409.
        second = self.client.post(
            f"/v1/reviews/{review_id}/pick", json={"take_id": t2})
        self.assertEqual(second.status_code, 409)

    def test_preferred_empty_store_reports_zero_picks(self) -> None:
        resp = self.client.get("/v1/reviews/preferred")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"character_id": None, "picks": 0,
                                       "counts": {}})


class PackImportErrorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(appmod.app, raise_server_exceptions=False)

    def test_not_a_zip_is_400(self) -> None:
        resp = self.client.post(
            "/v1/characters/import",
            files={"file": ("c.gravichar", b"definitely not a zip", "application/zip")})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("zip", resp.json()["detail"])

    def test_zip_without_manifest_is_400(self) -> None:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("readme.txt", "hi")
        resp = self.client.post(
            "/v1/characters/import",
            files={"file": ("c.gravichar", buf.getvalue(), "application/zip")})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("manifest", resp.json()["detail"])

    def test_export_unknown_character_is_404(self) -> None:
        resp = self.client.get("/v1/characters/no-such-character/pack")
        self.assertEqual(resp.status_code, 404)


if __name__ == "__main__":
    unittest.main()
