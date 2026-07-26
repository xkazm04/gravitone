"""Cross-process registry exclusion.

`_META_LOCK` is a `threading.RLock` — it serializes threads in ONE process,
while the service ships as N single-worker processes (service/replicas.py).
Two replicas could each load the registry, each add a voice and each save:
`os.replace` keeps the file intact but one entry is silently lost. `file_lock`
(the generalized form of takes.py's O_EXCL `.pick` sentinel) closes that.
"""
from __future__ import annotations

import os
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from service.atomicio import file_lock


class FileLockTests(unittest.TestCase):
    def test_excludes_a_second_holder_until_released(self) -> None:
        with TemporaryDirectory() as td:
            lock = Path(td) / "x.lock"
            entered_second = threading.Event()
            order: list[str] = []

            with file_lock(lock):
                order.append("first-in")

                def contender() -> None:
                    with file_lock(lock, timeout=5):
                        order.append("second-in")
                        entered_second.set()

                t = threading.Thread(target=contender)
                t.start()
                # The contender must NOT get in while we hold it.
                self.assertFalse(entered_second.wait(0.3))
                order.append("first-out")
            t.join(5)
            self.assertTrue(entered_second.is_set())
            self.assertEqual(order, ["first-in", "first-out", "second-in"])

    def test_released_lock_file_is_removed(self) -> None:
        with TemporaryDirectory() as td:
            lock = Path(td) / "x.lock"
            with file_lock(lock):
                self.assertTrue(lock.exists())
            self.assertFalse(lock.exists())

    def test_times_out_rather_than_proceeding_unlocked(self) -> None:
        # Losing a registry update silently is worse than failing loudly.
        with TemporaryDirectory() as td:
            lock = Path(td) / "x.lock"
            with file_lock(lock):
                with self.assertRaises(TimeoutError):
                    with file_lock(lock, timeout=0.1, stale_after=999):
                        self.fail("must not acquire a held lock")

    def test_breaks_a_stale_lock_left_by_a_killed_holder(self) -> None:
        # SIGKILL (docker stop, k8s grace expiry) leaves the file behind; a
        # lock nobody holds must not wedge the service forever.
        with TemporaryDirectory() as td:
            lock = Path(td) / "x.lock"
            os.close(os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            old = time.time() - 120
            os.utime(lock, (old, old))
            with file_lock(lock, timeout=2, stale_after=60):
                pass  # reclaimed
            self.assertFalse(lock.exists())

    def test_lock_is_released_when_the_body_raises(self) -> None:
        with TemporaryDirectory() as td:
            lock = Path(td) / "x.lock"
            with self.assertRaises(ValueError):
                with file_lock(lock):
                    raise ValueError("boom")
            self.assertFalse(lock.exists())
            with file_lock(lock, timeout=0.5):  # acquirable again
                pass


class MutateMetaUsesTheCrossProcessLockTests(unittest.TestCase):
    def test_mutate_meta_holds_the_lock_file(self) -> None:
        import service.voices as voices

        seen: list[bool] = []

        def _mutation(meta: dict) -> None:
            # While the mutation runs, the lock file must exist on disk — that
            # is what another REPLICA would contend on.
            seen.append(voices._META_LOCK_PATH.exists())

        voices.mutate_meta(_mutation)
        self.assertEqual(seen, [True])
        self.assertFalse(voices._META_LOCK_PATH.exists(), "lock must be released")


if __name__ == "__main__":
    unittest.main()
