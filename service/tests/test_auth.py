"""Auth layer — the 401/scope matrix that was structurally untestable.

The package-level env pin (`tests/__init__.py` forces TTS_API_KEY="") keeps the
rest of the suite in open mode; these tests re-enable enforcement by rebinding
`service.auth.SETTINGS` (a frozen dataclass — swapped, not mutated) and stubbing
`service.auth.validate_key` for managed-key scenarios. Nothing here touches the
environment, so the open-mode pin stays true for every other module.
"""
from __future__ import annotations

import dataclasses
import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
import service.auth as auth
from fastapi.testclient import TestClient

ROOT = "root-key-for-tests"


class AuthEnforcementTests(unittest.TestCase):
    def setUp(self) -> None:
        self._settings = auth.SETTINGS
        self._validate = auth.validate_key
        self._engine = appmod.ENGINE
        auth.SETTINGS = dataclasses.replace(auth.SETTINGS, api_key=ROOT)
        self.engine = fake_engine.FakeEngine(workers=1, delay=0.01)
        appmod.ENGINE = self.engine
        self.client = TestClient(appmod.app, raise_server_exceptions=False)

    def tearDown(self) -> None:
        auth.SETTINGS = self._settings
        auth.validate_key = self._validate
        appmod.ENGINE = self._engine
        self.engine.close()

    def _synth(self, headers: dict | None = None):
        return self.client.post(
            "/v1/text-to-speech/alba",
            params={"output_format": "wav_24000"},
            json={"text": "hello"},
            headers=headers or {},
        )

    def test_missing_key_is_401_with_scope_in_detail(self) -> None:
        resp = self._synth()
        self.assertEqual(resp.status_code, 401)
        self.assertIn("scope 'tts'", resp.json()["detail"])

    def test_wrong_key_is_401(self) -> None:
        auth.validate_key = lambda secret, scope: False
        resp = self._synth({"xi-api-key": "not-the-key"})
        self.assertEqual(resp.status_code, 401)

    def test_root_key_via_xi_api_key_passes(self) -> None:
        resp = self._synth({"xi-api-key": ROOT})
        self.assertEqual(resp.status_code, 200)

    def test_root_key_via_bearer_passes(self) -> None:
        resp = self._synth({"Authorization": f"Bearer {ROOT}"})
        self.assertEqual(resp.status_code, 200)

    def test_managed_key_with_scope_passes(self) -> None:
        auth.validate_key = (
            lambda secret, scope: secret == "managed-1" and scope == "tts")
        resp = self._synth({"xi-api-key": "managed-1"})
        self.assertEqual(resp.status_code, 200)

    def test_managed_key_never_reaches_admin_surface(self) -> None:
        # Even a validate_key that says yes to everything must not open key
        # management: scope "admin" skips the managed-key branch entirely.
        auth.validate_key = lambda secret, scope: True
        resp = self.client.get("/v1/keys", headers={"xi-api-key": "managed-1"})
        self.assertEqual(resp.status_code, 401)

    def test_admin_surface_opens_for_root(self) -> None:
        resp = self.client.get("/v1/keys", headers={"xi-api-key": ROOT})
        self.assertEqual(resp.status_code, 200)

    def test_read_write_split(self) -> None:
        # A read-scoped key may GET the voices list but not mutate it.
        auth.validate_key = (
            lambda secret, scope: secret == "reader" and scope == "tts")
        r_get = self.client.get("/v1/voices", headers={"xi-api-key": "reader"})
        self.assertEqual(r_get.status_code, 200)
        r_del = self.client.delete("/v1/voices/some-voice",
                                   headers={"xi-api-key": "reader"})
        self.assertEqual(r_del.status_code, 401)


if __name__ == "__main__":
    unittest.main()
