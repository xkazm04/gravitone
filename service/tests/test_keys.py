"""Direction 3 — key-store hardening (lock, debounce, revoked-rotate).

service.keys imports only fastapi/pydantic/config, so these run without the
model stack. Each test points KEYS_PATH at a temp file and resets the module
caches.
"""
from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path

from fastapi import HTTPException

import service.keys as keys


class KeyStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_path = keys.KEYS_PATH
        self._orig_save = keys._save
        self._tmpdir = tempfile.TemporaryDirectory()
        keys.KEYS_PATH = Path(self._tmpdir.name) / "api_keys.json"
        keys._LAST_USED.clear()
        keys._LAST_PERSIST.clear()

    def tearDown(self) -> None:
        keys.KEYS_PATH = self._orig_path
        keys._save = self._orig_save
        self._tmpdir.cleanup()

    def _make_key(self, scopes=("tts",)):
        res = keys.create_key(keys.CreateKey(name="t", scopes=list(scopes)))
        return res.id, res.secret

    def test_last_used_persistence_is_debounced(self) -> None:
        kid, secret = self._make_key()
        calls = {"n": 0}
        orig = keys._save

        def counting(data):
            calls["n"] += 1
            orig(data)

        keys._save = counting
        # First authenticated use persists; the immediate second use does not
        # (debounced) — but the in-memory view is updated both times.
        self.assertTrue(keys.validate_key(secret, "tts"))
        self.assertEqual(calls["n"], 1)
        self.assertIn(kid, keys._LAST_USED)
        self.assertTrue(keys.validate_key(secret, "tts"))
        self.assertEqual(calls["n"], 1)  # no second rewrite within the window

    def test_concurrent_validate_never_corrupts_store(self) -> None:
        _, secret = self._make_key()

        errors: list[Exception] = []
        writes: list[int] = []

        # validate_key DEBOUNCES its last_used persist (60s). Left at the
        # default, the first validate writes and the other ~399 skip _save
        # entirely — exactly ONE write happens, under the lock, so this test
        # would pass even with NO locking at all and proves nothing about the
        # concurrent read-modify-write it advertises. Disable the debounce so
        # every validate performs a real write, and count them to prove it.
        orig_debounce = keys._LAST_USED_DEBOUNCE_S
        orig_save = keys._save

        def counting_save(data):
            writes.append(1)
            orig_save(data)

        keys._LAST_USED_DEBOUNCE_S = -1.0  # elapsed is always > -1 -> never debounced
        keys._save = counting_save
        self.addCleanup(setattr, keys, "_LAST_USED_DEBOUNCE_S", orig_debounce)
        self.addCleanup(setattr, keys, "_save", orig_save)

        def hammer():
            try:
                for _ in range(50):
                    keys.validate_key(secret, "tts")
            except Exception as exc:  # pragma: no cover - failure surfaces below
                errors.append(exc)

        threads = [threading.Thread(target=hammer) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [])
        # Real concurrent writers actually ran — without this the assertion
        # below is satisfied by a single serialized write.
        self.assertGreater(len(writes), 100,
                           "debounce still suppressing writes — the test proves nothing")
        # The file survived concurrent read-modify-write intact.
        data = json.loads(keys.KEYS_PATH.read_text("utf-8"))
        self.assertEqual(len(data), 1)

    def test_rotate_revoked_key_is_rejected_and_stays_revoked(self) -> None:
        kid, secret = self._make_key()
        data = keys._load()
        data[kid]["revoked"] = True
        keys._save(data)

        with self.assertRaises(HTTPException) as ctx:
            keys.rotate_key(kid)
        self.assertEqual(ctx.exception.status_code, 409)
        # Still revoked, and the old secret is still invalid.
        self.assertTrue(keys._load()[kid]["revoked"])
        self.assertFalse(keys.validate_key(secret, "tts"))

    def test_rotate_active_key_still_works(self) -> None:
        kid, secret = self._make_key()
        res = keys.rotate_key(kid)
        self.assertNotEqual(res.secret, secret)
        self.assertFalse(keys._load()[kid]["revoked"])
        self.assertTrue(keys.validate_key(res.secret, "tts"))
        self.assertFalse(keys.validate_key(secret, "tts"))  # old secret dead


if __name__ == "__main__":
    unittest.main()
