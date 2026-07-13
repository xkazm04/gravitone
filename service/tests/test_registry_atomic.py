"""Direction 1 — locked, atomic voice registry.

Proves the shared write path in :mod:`service.voices`:

  * ``mutate_meta`` serializes concurrent read-modify-write cycles, so racing
    threads never clobber each other's entries (the two-concurrent-clones bug).
  * ``_save_meta`` replaces the registry atomically — a crash (exception) mid
    ``fn`` leaves the previous file byte-for-byte intact, never truncated.
  * every write goes through the atomic replace (temp file + os.replace).
"""
from __future__ import annotations

import json
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service.tests import fake_engine  # noqa: F401  (installs dep shims early)
from service import voices as vc


class _Registry:
    """Point voices at a throwaway registry dir for the duration of a test."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._patchers = [
            mock.patch.object(vc, "VOICES_DIR", root),
            mock.patch.object(vc, "META_PATH", root / "_meta.json"),
        ]

    def __enter__(self) -> "_Registry":
        for p in self._patchers:
            p.start()
        return self

    def __exit__(self, *exc) -> None:
        for p in self._patchers:
            p.stop()


class ConcurrentMutateTests(unittest.TestCase):
    def test_racing_mutators_lose_no_entries(self) -> None:
        with TemporaryDirectory() as td:
            with _Registry(Path(td)):
                n = 60
                barrier = threading.Barrier(n)

                def add(i: int) -> None:
                    barrier.wait()  # maximize the race window

                    def _fn(meta: dict) -> None:
                        meta["voices"][f"v{i}"] = {"character_id": "c", "emotion": "baseline"}

                    vc.mutate_meta(_fn)

                threads = [threading.Thread(target=add, args=(i,)) for i in range(n)]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join()

                meta = vc._load_meta()
                self.assertEqual(len(meta["voices"]), n,
                                 "concurrent mutate_meta lost entries")
                self.assertEqual({f"v{i}" for i in range(n)}, set(meta["voices"]))


class AtomicCrashSafetyTests(unittest.TestCase):
    def test_exception_mid_fn_leaves_previous_file_intact(self) -> None:
        with TemporaryDirectory() as td:
            with _Registry(Path(td)):
                vc.mutate_meta(lambda m: m["voices"].update({"keep": {"emotion": "baseline"}}))
                before = (Path(td) / "_meta.json").read_bytes()

                def _boom(meta: dict) -> None:
                    meta["voices"]["ghost"] = {"emotion": "sad"}  # mutate then blow up
                    raise RuntimeError("crash mid-write")

                with self.assertRaises(RuntimeError):
                    vc.mutate_meta(_boom)

                after = (Path(td) / "_meta.json").read_bytes()
                self.assertEqual(before, after, "failed mutation altered the registry")
                self.assertNotIn("ghost", json.loads(after)["voices"])

    def test_no_stray_tmp_files_after_writes(self) -> None:
        with TemporaryDirectory() as td:
            with _Registry(Path(td)):
                vc.mutate_meta(lambda m: m["voices"].update({"a": {"emotion": "baseline"}}))
                with self.assertRaises(RuntimeError):
                    vc.mutate_meta(lambda m: (_ for _ in ()).throw(RuntimeError("x")))
                leftovers = list(Path(td).glob("._meta-*.tmp"))
                self.assertEqual(leftovers, [], f"atomic write left temp files: {leftovers}")


class ContractTests(unittest.TestCase):
    def test_mutate_meta_returns_fn_result(self) -> None:
        with TemporaryDirectory() as td:
            with _Registry(Path(td)):
                out = vc.mutate_meta(lambda m: "sentinel")
                self.assertEqual(out, "sentinel")

    def test_packs_import_uses_the_shared_helper(self) -> None:
        import service.packs as pk
        # packs must go through the public helper, not reach for _save_meta.
        self.assertTrue(hasattr(pk, "mutate_meta"))
        self.assertFalse(hasattr(pk, "_save_meta"),
                         "packs.py should not import the private writer")


if __name__ == "__main__":
    unittest.main()
