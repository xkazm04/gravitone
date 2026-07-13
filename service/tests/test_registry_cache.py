"""Direction 2 — registry read cache.

emotion_map/list_characters/all_voices/get_voice sit in the synthesis hot path
and each reduced to a full _load_meta + VOICES_DIR glob on every call. They now
serve from a fingerprint-keyed cache. These tests prove:

  * N consecutive reads trigger exactly ONE disk load (cache hit thereafter),
  * a mutate_meta write invalidates the cache,
  * cached output is identical to a fresh assembly,
  * all_demand() is TTL-cached (telemetry staleness is acceptable).
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service.tests import fake_engine  # noqa: F401  (installs dep shims early)
from service import voices as vc


def _seed_registry(root: Path) -> None:
    """One cloned character ('ada') with a baseline + happy voice on disk."""
    meta = {
        "voices": {
            "ada-baseline-aaa": {"name": "Ada", "character_id": "ada", "emotion": "baseline"},
            "ada-happy-bbb": {"name": "Ada", "character_id": "ada", "emotion": "happy"},
        },
        "characters": {"ada": {"name": "Ada", "tags": []}},
    }
    (root / "_meta.json").write_text(json.dumps(meta), "utf-8")
    (root / "ada-baseline-aaa.safetensors").write_bytes(b"x")
    (root / "ada-happy-bbb.safetensors").write_bytes(b"y")


class _Registry:
    def __init__(self, root: Path) -> None:
        self._patchers = [
            mock.patch.object(vc, "VOICES_DIR", root),
            mock.patch.object(vc, "META_PATH", root / "_meta.json"),
        ]

    def __enter__(self) -> "_Registry":
        for p in self._patchers:
            p.start()
        # Start every test from a cold cache.
        vc._chars_cache = None
        vc._chars_cache_key = None
        vc._demand_cache = None
        return self

    def __exit__(self, *exc) -> None:
        for p in self._patchers:
            p.stop()


class ReadCacheTests(unittest.TestCase):
    def test_consecutive_reads_do_one_disk_load(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _seed_registry(root)
            with _Registry(root):
                orig = vc._load_meta
                loads: list[int] = []

                def counting() -> dict:
                    loads.append(1)
                    return orig()

                with mock.patch.object(vc, "_load_meta", counting):
                    maps = [vc.emotion_map("ada") for _ in range(8)]

                self.assertEqual(len(loads), 1, "hot path re-parsed the registry")
                # Every read returned the same, correct map.
                self.assertEqual(maps[0], {"baseline": "ada-baseline-aaa",
                                           "happy": "ada-happy-bbb"})
                self.assertTrue(all(m == maps[0] for m in maps))

    def test_repeated_reads_return_the_same_cached_object(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _seed_registry(root)
            with _Registry(root):
                self.assertIs(vc.list_characters(), vc.list_characters())

    def test_mutate_meta_invalidates_the_cache(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _seed_registry(root)
            with _Registry(root):
                before = vc.list_characters()
                vc.mutate_meta(
                    lambda m: m["characters"].__setitem__("ada", {"name": "Ada Prime", "tags": []}))
                after = vc.list_characters()
                self.assertIsNot(before, after, "cache survived a write")
                ada = next(c for c in after if c.character_id == "ada")
                self.assertEqual(ada.name, "Ada Prime")

    def test_invalidate_forces_reassembly(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _seed_registry(root)
            with _Registry(root):
                a = vc.list_characters()
                vc.invalidate()
                self.assertIsNot(a, vc.list_characters())

    def test_cached_output_matches_fresh_build(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _seed_registry(root)
            with _Registry(root):
                cached = vc.list_characters()
                fresh = vc._build_characters()
                proj = lambda cs: [(c.character_id, c.emotions, c.scale, c.coverage) for c in cs]
                self.assertEqual(proj(cached), proj(fresh))


class DemandTtlTests(unittest.TestCase):
    def test_all_demand_is_ttl_cached(self) -> None:
        with TemporaryDirectory() as td:
            with _Registry(Path(td)):
                calls: list[int] = []

                def counting() -> dict:
                    calls.append(1)
                    return {"ada": {"angry": 3}}

                with mock.patch.object(vc, "all_demand", counting):
                    vc._demand_cache = None
                    first = vc._cached_demand()
                    for _ in range(5):
                        vc._cached_demand()
                    self.assertEqual(len(calls), 1, "demand read every call — TTL not applied")
                    self.assertEqual(first, {"ada": {"angry": 3}})

                    # Expire the TTL → one more read.
                    vc._demand_cache_at -= vc._DEMAND_TTL + 1
                    vc._cached_demand()
                    self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
