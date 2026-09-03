"""Key-store hardening: cross-process lock, read index, revocation, debounce.

service.keys imports only fastapi/pydantic/config/errors, so most of these run
without the model stack. Each test points KEYS_PATH at a temp file and resets
the module caches.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path

from fastapi import HTTPException

import service.keys as keys
from service.atomicio import atomic_write_text
from service.config import REPO_ROOT


class KeyStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_path = keys.KEYS_PATH
        self._orig_save = keys._save
        self._tmpdir = tempfile.TemporaryDirectory()
        keys.KEYS_PATH = Path(self._tmpdir.name) / "api_keys.json"
        keys._LAST_USED.clear()
        keys._LAST_PERSIST.clear()
        keys.invalidate_index()

    def tearDown(self) -> None:
        keys.KEYS_PATH = self._orig_path
        keys._save = self._orig_save
        keys.invalidate_index()
        self._tmpdir.cleanup()

    def _write_external(self, data: dict) -> None:
        """Simulate ANOTHER replica writing the store: an atomic write that
        never goes through this process's _save (so no generation bump)."""
        atomic_write_text(keys.KEYS_PATH, json.dumps(data, indent=2))

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

    # ── revocation ────────────────────────────────────────────────────────────
    def test_revoke_kills_the_key_but_keeps_it_listed(self) -> None:
        kid, secret = self._make_key()
        self.assertTrue(keys.validate_key(secret, "tts"))

        out = keys.revoke_key(kid)
        self.assertTrue(out.revoked)
        # Dead for auth...
        self.assertFalse(keys.validate_key(secret, "tts"))
        # ...but still auditable: listed, with its scopes/created/last_used.
        listed = {k.id: k for k in keys.list_keys()}
        self.assertIn(kid, listed)
        self.assertTrue(listed[kid].revoked)
        self.assertIsNotNone(listed[kid].last_used)
        # ...and unrotatable (no path back into service).
        with self.assertRaises(HTTPException) as ctx:
            keys.rotate_key(kid)
        self.assertEqual(ctx.exception.status_code, 409)

    def test_revoke_is_idempotent_and_404s_for_unknown(self) -> None:
        kid, _ = self._make_key()
        keys.revoke_key(kid)
        self.assertTrue(keys.revoke_key(kid).revoked)  # second call succeeds
        with self.assertRaises(HTTPException) as ctx:
            keys.revoke_key("nope")
        self.assertEqual(ctx.exception.status_code, 404)

    # ── read index ────────────────────────────────────────────────────────────
    def test_validate_does_not_read_the_file_on_the_common_path(self) -> None:
        _, secret = self._make_key()
        # First use persists last_used (debounce cold), which invalidates the
        # index; the second call rebuilds it against the post-write file.
        self.assertTrue(keys.validate_key(secret, "tts"))
        self.assertTrue(keys.validate_key(secret, "tts"))
        loads = {"n": 0}
        orig_load = keys._load

        def counting_load():
            loads["n"] += 1
            return orig_load()

        keys._load = counting_load
        self.addCleanup(setattr, keys, "_load", orig_load)
        for _ in range(20):
            self.assertTrue(keys.validate_key(secret, "tts"))
        # Debounced: no persist, and the index served every read.
        self.assertEqual(loads["n"], 0)

    def test_index_picks_up_an_out_of_band_write(self) -> None:
        kid, secret = self._make_key()
        self.assertTrue(keys.validate_key(secret, "tts"))  # warms the index

        # Another replica revokes it. No _save here, so only the stat
        # fingerprint can catch this.
        data = keys._load()
        data[kid]["revoked"] = True
        self._write_external(data)
        self.assertFalse(keys.validate_key(secret, "tts"))

        # And the additive direction: a key this process never created.
        other = keys.create_key(keys.CreateKey(name="peer", scopes=["tts"]))
        raw = json.loads(keys.KEYS_PATH.read_text("utf-8"))
        self._write_external(raw)
        self.assertTrue(keys.validate_key(other.secret, "tts"))

    # ── debounce × revocation/deletion ────────────────────────────────────────
    def test_debounced_persist_never_resurrects_a_revoked_key(self) -> None:
        kid, secret = self._make_key()
        self.assertTrue(keys.validate_key(secret, "tts"))
        keys._LAST_PERSIST[kid] = time.monotonic() - 10_000  # debounce expired

        # Another replica revokes while our index still says "active".
        data = keys._load()
        data[kid]["revoked"] = True
        data[kid]["last_used"] = None
        self._write_external(data)

        # The persist path re-reads under the lock and refuses to write.
        keys._persist_last_used(kid, "2099-01-01T00:00:00+00:00")
        after = keys._load()[kid]
        self.assertTrue(after["revoked"])
        self.assertIsNone(after["last_used"])
        self.assertNotIn(kid, keys._LAST_USED)

    def test_debounced_persist_never_resurrects_a_deleted_key(self) -> None:
        kid, secret = self._make_key()
        self.assertTrue(keys.validate_key(secret, "tts"))
        keys._LAST_PERSIST[kid] = time.monotonic() - 10_000

        self._write_external({})  # another replica deleted it
        keys._persist_last_used(kid, "2099-01-01T00:00:00+00:00")
        self.assertEqual(keys._load(), {})
        self.assertNotIn(kid, keys._LAST_USED)

    def test_revoked_key_is_not_bumped_at_all(self) -> None:
        kid, secret = self._make_key()
        keys.revoke_key(kid)
        keys._LAST_USED.pop(kid, None)
        writes: list[int] = []
        orig_save = keys._save
        keys._save = lambda data: (writes.append(1), orig_save(data))[1]
        self.addCleanup(setattr, keys, "_save", orig_save)
        self.assertFalse(keys.validate_key(secret, "tts"))
        self.assertEqual(writes, [])
        self.assertNotIn(kid, keys._LAST_USED)


# ── cross-PROCESS exclusion ───────────────────────────────────────────────────
# The service runs as N single-worker replica processes (service/replicas.py),
# so the thread lock alone proves nothing. Real child processes, started
# together on a filesystem barrier, each issue keys into ONE store; without
# atomicio.file_lock in keys._mutate they read the same file and each save,
# silently dropping the other's keys.
_CHILD = textwrap.dedent("""
    import os, sys, time
    from pathlib import Path
    sys.path.insert(0, os.environ["GRAVITONE_REPO_ROOT"])
    import service.keys as keys

    store, barrier, count, tag = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    keys.KEYS_PATH = store
    deadline = time.time() + 30
    while not barrier.exists() and time.time() < deadline:
        time.sleep(0.005)
    for i in range(count):
        keys.create_key(keys.CreateKey(name=f"{tag}-{i}", scopes=["tts"]))
""")


class CrossProcessKeyStoreTests(unittest.TestCase):
    PROCS = 3
    PER_PROC = 12

    def test_concurrent_replicas_lose_no_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / "api_keys.json"
            barrier = Path(tmp) / "go"
            script = Path(tmp) / "child.py"
            script.write_text(_CHILD, "utf-8")
            env = dict(os.environ, GRAVITONE_REPO_ROOT=str(REPO_ROOT))
            procs = [
                subprocess.Popen(
                    [sys.executable, str(script), str(store), str(barrier),
                     str(self.PER_PROC), f"p{i}"],
                    cwd=str(REPO_ROOT), env=env, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, text=True)
                for i in range(self.PROCS)
            ]
            time.sleep(1.5)  # let every child finish importing before the start gun
            barrier.write_text("go", "utf-8")
            for p in procs:
                out, err = p.communicate(timeout=120)
                self.assertEqual(p.returncode, 0, f"child failed: {err or out}")

            data = json.loads(store.read_text("utf-8"))
            self.assertEqual(len(data), self.PROCS * self.PER_PROC,
                             "keys were lost to a cross-process lost update")
            self.assertEqual(len({k["hash"] for k in data.values()}),
                             self.PROCS * self.PER_PROC)


if __name__ == "__main__":
    unittest.main()
