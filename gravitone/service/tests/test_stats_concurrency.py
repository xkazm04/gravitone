"""Reads that happen on ANOTHER thread while the box is busy.

Two surfaces are scraped by the replica's admin server (`service/replicas.py`,
its own thread) while the event loop and the workers mutate underneath:

* `SynthCache.stats()` — samples sizes and integer counters, never iterates;
* `TtsEngine.voice_lru_keys()` — used to iterate a live worker's LRU, which
  raises "dictionary changed size during iteration" exactly when the box is
  busy enough for voice affinity to matter, and `introspect_doc` swallowed it.

Both are hammered here: a mutator thread churning while a reader thread reads,
asserting no exception and a consistent SHAPE. A single-threaded test would
have passed against both bugs.
"""
from __future__ import annotations

import threading
import unittest

from service.tests import fake_engine  # installs shims — must precede engine

from service import engine as engine_mod
from service import replicas as rep
from service.cache import CachedAudio, SynthCache

STATS_KEYS = {"enabled", "entries", "bytes", "max_bytes", "hits", "misses",
              "evictions", "collapsed", "bypassed", "in_flight"}


def _hammer(mutate, read, seconds: float = 0.5):
    """Run `mutate` in a loop on one thread while `read` runs on another.

    Returns the reader's results. Any exception on either side is re-raised in
    the test thread — a silently dying hammer thread would make this test a
    green light for the bug it exists to catch.
    """
    stop = threading.Event()
    errors: list[BaseException] = []
    results: list = []

    def _loop(fn, sink):
        try:
            while not stop.is_set():
                out = fn()
                if sink is not None:
                    sink.append(out)
        except BaseException as exc:  # noqa: BLE001 - reported, not swallowed
            errors.append(exc)

    threads = [threading.Thread(target=_loop, args=(mutate, None), daemon=True),
               threading.Thread(target=_loop, args=(read, results), daemon=True)]
    for t in threads:
        t.start()
    stop.wait(seconds)
    stop.set()
    for t in threads:
        t.join(timeout=10)
    if errors:
        raise errors[0]
    return results


class CacheStatsUnderMutationTests(unittest.TestCase):
    def test_stats_never_raises_while_the_loop_puts_and_evicts(self) -> None:
        cache: SynthCache[CachedAudio] = SynthCache(max_bytes=4096)
        counter = [0]

        def mutate() -> None:
            i = counter[0] = counter[0] + 1
            cache.put(f"k{i % 64}", CachedAudio(b"x" * 512, 24000, 0.1))
            cache.get(f"k{(i * 7) % 64}")
            cache.hits += 1

        docs = _hammer(mutate, cache.stats)
        self.assertGreater(len(docs), 10)
        for doc in docs:
            self.assertEqual(set(doc), STATS_KEYS)
            self.assertGreaterEqual(doc["entries"], 0)
            self.assertGreaterEqual(doc["bytes"], 0)
            self.assertIs(type(doc["enabled"]), bool)

    def test_stats_survives_a_resize_swapping_state_underneath(self) -> None:
        cache: SynthCache[CachedAudio] = SynthCache(max_bytes=4096)
        flip = [0]

        def mutate() -> None:
            flip[0] += 1
            cache.put(f"k{flip[0] % 32}", CachedAudio(b"y" * 256, 24000, 0.1))
            cache.resize(4096 if flip[0] % 2 else 512)

        for doc in _hammer(mutate, cache.stats):
            self.assertEqual(set(doc), STATS_KEYS)
            # max_bytes and enabled are read from ONE sample of the budget, so
            # they can never contradict each other.
            self.assertEqual(doc["enabled"], doc["max_bytes"] > 0)


class _CacheWorker(engine_mod._Worker):
    """A worker with no thread and no model: only the voice LRU is under test."""

    def __init__(self) -> None:
        engine_mod._Worker.__init__(self, 0, engine=None)


class VoiceLruSnapshotTests(unittest.TestCase):
    def _engine(self, workers):
        class _E:
            pass

        e = _E()
        e._workers = workers
        e.voice_lru_keys = lambda: engine_mod.TtsEngine.voice_lru_keys(e)
        return e

    def test_reading_the_lru_while_a_worker_churns_it_does_not_raise(self) -> None:
        w = _CacheWorker()
        engine = self._engine([w])
        counter = [0]

        def mutate() -> None:
            i = counter[0] = counter[0] + 1
            with w._voice_lock:
                w._voice_cache[f"voice-{i % 12}"] = {"state": i}
                w._voice_cache.move_to_end(f"voice-{i % 12}")
                if len(w._voice_cache) > engine_mod._VOICE_CACHE_MAX:
                    w._voice_cache.popitem(last=False)

        snapshots = _hammer(mutate, engine.voice_lru_keys)
        self.assertGreater(len(snapshots), 10)
        for keys in snapshots:
            self.assertIsInstance(keys, list)
            self.assertEqual(keys, sorted(keys))
            self.assertLessEqual(len(keys), engine_mod._VOICE_CACHE_MAX)
            self.assertTrue(all(k.startswith("voice-") for k in keys))

    def test_the_snapshot_is_a_copy_not_the_live_view(self) -> None:
        w = _CacheWorker()
        w._voice_cache["nova"] = {}
        keys = w.voice_cache_keys()
        w._voice_cache["sarah"] = {}
        self.assertEqual(keys, ["nova"], "the caller was handed a live view")

    def test_two_workers_fold_into_one_deduplicated_answer(self) -> None:
        a, b = _CacheWorker(), _CacheWorker()
        a._voice_cache["nova"] = {}
        b._voice_cache["nova"] = {}
        b._voice_cache["sarah"] = {}
        self.assertEqual(self._engine([a, b]).voice_lru_keys(), ["nova", "sarah"])


class IntrospectDoesNotSwallowTests(unittest.TestCase):
    """The accessor can no longer raise — but if it ever does, the router must
    learn "unknown", not "no hot voices"."""

    def test_a_failing_accessor_is_reported_in_the_document(self) -> None:
        class _Broken:
            ready = True
            draining = False

            def voice_lru_keys(self):
                raise RuntimeError("dictionary changed size during iteration")

        doc = rep.introspect_doc(_Broken(), index=2)
        self.assertNotIn("voice_lru_keys", doc)
        self.assertIn("dictionary changed size", doc["voice_lru_keys_error"])

    def test_the_error_survives_into_the_pool_view(self) -> None:
        doc = rep.aggregate_introspection(
            [(0, "a")],
            fetch=lambda u: {"available_permits": 1,
                             "voice_lru_keys_error": "RuntimeError: boom"})
        self.assertEqual(doc["replicas"][0]["voice_lru_keys_error"],
                         "RuntimeError: boom")
        self.assertEqual(doc["voices"], {})

    def test_a_healthy_engine_still_reports_its_voices(self) -> None:
        class _Fine:
            ready = True
            draining = False

            def voice_lru_keys(self):
                return ["nova", "nova", "sarah"]

        doc = rep.introspect_doc(_Fine(), index=0)
        self.assertEqual(doc["voice_lru_keys"], ["nova", "sarah"])
        self.assertNotIn("voice_lru_keys_error", doc)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
