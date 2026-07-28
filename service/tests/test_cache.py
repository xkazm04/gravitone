"""Synthesis result cache + single-flight (service/cache.py).

Cache-key correctness is the whole ballgame, so the identity cases walk every
field of the request that can change audio (text, each VoiceSettings override,
frames_after_eos, the RESOLVED emotion voice) and prove each one moves the key
— plus the one field that must NOT (an emotion address that resolves to the
same voice). The rest pins the mechanics: concurrent identical requests
collapse onto one synthesis, a re-cloned voice invalidates its audio, the byte
budget really evicts, and a hit reports its REAL timings.
"""
from __future__ import annotations

import asyncio
import dataclasses
import os
import tempfile
import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
from service.app import TTSRequest
from service.cache import CachedAudio, SynthCache
from fastapi.testclient import TestClient

_EMAP = {"baseline": "v_base", "happy": "v_happy"}


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_engine = appmod.ENGINE
        self._orig_settings = appmod.SETTINGS
        self._orig_emap = appmod.emotion_map
        appmod.SYNTH_CACHE.clear()
        appmod.SYNTH_CACHE.resize(8 * 1024 * 1024)
        self.engine = fake_engine.FakeEngine(workers=4, delay=0.02)
        appmod.ENGINE = self.engine
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        self.engine.close()
        appmod.ENGINE = self._orig_engine
        appmod.SETTINGS = self._orig_settings
        appmod.emotion_map = self._orig_emap
        appmod.SYNTH_CACHE.clear()
        appmod.SYNTH_CACHE.resize(self._orig_settings.cache_bytes)

    def _post(self, body: dict, voice: str = "alba", **params):
        return self.client.post(
            f"/v1/text-to-speech/{voice}",
            params={"output_format": "wav_24000", **params}, json=body)


class CacheIdentityTests(_Base):
    def test_identical_request_is_a_hit_and_synthesizes_once(self) -> None:
        first = self._post({"text": "Cache me."})
        second = self._post({"text": "Cache me."})
        self.assertEqual(first.headers["x-cache"], "miss")
        self.assertEqual(second.headers["x-cache"], "hit")
        self.assertEqual(second.content, first.content)
        self.assertEqual(len(self.engine.jobs), 1, "hit must not synthesize")

    def test_different_text_is_a_miss(self) -> None:
        self._post({"text": "One thing."})
        resp = self._post({"text": "Another thing."})
        self.assertEqual(resp.headers["x-cache"], "miss")
        self.assertEqual(len(self.engine.jobs), 2)

    def test_every_effective_voice_setting_moves_the_key(self) -> None:
        base = {"text": "Same words."}
        self._post(base)
        # temperature -> temp, stability -> noise_clamp, quality ->
        # lsd_decode_steps: each reaches the model, so each must miss.
        for settings in ({"temperature": 0.9}, {"stability": 0.8},
                         {"quality": 4}):
            with self.subTest(settings=settings):
                resp = self._post({**base, "voice_settings": settings})
                self.assertEqual(resp.headers["x-cache"], "miss")
        # ...and repeating one of them now hits.
        again = self._post({**base, "voice_settings": {"temperature": 0.9}})
        self.assertEqual(again.headers["x-cache"], "hit")

    def test_inert_settings_do_not_move_the_key(self) -> None:
        # similarity_boost / style are accepted but never reach the model (they
        # are reported via X-Ignored-Settings). Keying on them would waste the
        # cache on requests that are bit-for-bit the same synthesis.
        self._post({"text": "Inert."})
        resp = self._post({"text": "Inert.",
                           "voice_settings": {"similarity_boost": 0.4, "style": 0.2}})
        self.assertEqual(resp.headers["x-cache"], "hit")
        self.assertEqual(resp.headers["x-ignored-settings"],
                         "similarity_boost,style")

    def test_frames_after_eos_moves_the_key(self) -> None:
        self._post({"text": "Trailing."})
        resp = self._post({"text": "Trailing.", "frames_after_eos": 6})
        self.assertEqual(resp.headers["x-cache"], "miss")

    def test_resolved_emotion_not_the_address_is_in_the_key(self) -> None:
        appmod.emotion_map = lambda cid: dict(_EMAP)
        happy = self._post({"text": "Feelings."}, voice="sarah:happy")
        self.assertEqual(happy.headers["x-cache"], "miss")
        # A different emotion resolves to a different voice -> different audio.
        sad = self._post({"text": "Feelings."}, voice="sarah:sad")  # falls back
        self.assertEqual(sad.headers["x-cache"], "miss")
        # Two spellings of the SAME resolved voice are one entry: the key holds
        # the resolved voice id, never the pre-resolution address.
        same = self._post({"text": "Feelings."}, voice="sarah", emotion="happy")
        self.assertEqual(same.headers["x-cache"], "hit")
        self.assertEqual(same.headers["x-emotion-used"], "happy")

    def test_output_format_is_not_in_the_key(self) -> None:
        # The cache stores native-rate WAV; formats are derived after lookup.
        self._post({"text": "Formats."})
        pcm = self._post({"text": "Formats."}, output_format="pcm_24000")
        self.assertEqual(pcm.headers["x-cache"], "hit")
        self.assertEqual(pcm.headers["x-sample-rate"], "24000")
        self.assertNotEqual(pcm.content[:4], b"RIFF")


class CacheHonestTimingTests(_Base):
    def test_hit_reports_its_real_cost_not_the_renders(self) -> None:
        miss = self._post({"text": "Timings."})
        hit = self._post({"text": "Timings."})
        self.assertEqual(float(miss.headers["x-synth-seconds"]), 0.02)
        hit_synth = float(hit.headers["x-synth-seconds"])
        # The hit did no synthesis: it must say so, not replay 0.02.
        self.assertLess(hit_synth, 0.02)
        self.assertGreater(hit_synth, 0.0)
        self.assertEqual(hit.headers["x-queue-seconds"], "0.0")
        # Audio duration is a property of the clip, so it stays accurate.
        self.assertEqual(hit.headers["x-audio-seconds"],
                         miss.headers["x-audio-seconds"])
        # A realtime factor is a claim about the MODEL, and the hit ran none:
        # audio ÷ ~1e-6s would be a number in the millions that a benchmark
        # would average and a certificate would sign. It must say "n/a".
        self.assertEqual(hit.headers["x-realtime-factor"], "n/a")
        self.assertNotEqual(miss.headers["x-realtime-factor"], "n/a")

    def test_bypass_renders_and_stores_nothing(self) -> None:
        first = self._post({"text": "Bypass me."})
        self.assertEqual(first.headers["x-cache"], "miss")
        entries = appmod.SYNTH_CACHE.stats()["entries"]
        bypassed = self.client.post(
            "/v1/text-to-speech/alba", params={"output_format": "wav_24000"},
            json={"text": "Bypass me."}, headers={"Cache-Control": "no-store"})
        self.assertEqual(bypassed.headers["x-cache"], "bypass")
        # Rendered fresh: a real synth time and a real realtime factor.
        self.assertEqual(float(bypassed.headers["x-synth-seconds"]), 0.02)
        self.assertNotEqual(bypassed.headers["x-realtime-factor"], "n/a")
        # ... and the shared cache is untouched by the bypassing caller.
        self.assertEqual(appmod.SYNTH_CACHE.stats()["entries"], entries)


class CacheServedRequestsAreCountedTests(_Base):
    """`received` must mean "requests this replica served", cache included.

    A cache-served request never reaches ``ENGINE.submit``, the only other
    place that bumps ``received`` — so ``Metrics.on_cache_hit`` /
    ``on_collapsed`` existed with ZERO production callers, ``/metrics``
    reported ``cache_hits: 0`` forever, and ``replicas.AGG_KEYS`` summed two
    structurally-zero fields across the pool. These cases drive real HTTP
    requests (not the Metrics object directly) so a dead call site fails here.
    """

    def test_http_cache_hit_increments_cache_hits_and_received(self) -> None:
        self._post({"text": "Counted."})            # miss -> one submit
        before = self.engine.metrics.snapshot()
        self.assertEqual(before["cache_hits"], 0)
        resp = self._post({"text": "Counted."})     # hit -> no submit at all
        self.assertEqual(resp.headers["x-cache"], "hit")
        after = self.engine.metrics.snapshot()
        self.assertEqual(after["cache_hits"], before["cache_hits"] + 1)
        # The point of the counter: the hit is still a request we SERVED.
        self.assertEqual(after["received"], before["received"] + 1)
        self.assertEqual(len(self.engine.jobs), 1, "a hit must not synthesize")

    def test_collapsed_requests_are_counted_as_collapses(self) -> None:
        async def _drive():
            return await asyncio.gather(*[
                appmod.text_to_speech("alba", TTSRequest(text="Herd."),
                                      output_format="wav_24000", emotion=None)
                for _ in range(4)])

        asyncio.run(_drive())
        snap = self.engine.metrics.snapshot()
        # One leader synthesized (its `received` came from submit); the other
        # three rode its render and are counted as collapses, not as hits.
        self.assertEqual(snap["collapsed"], 3)
        self.assertEqual(snap["cache_hits"], 0)
        self.assertEqual(snap["received"], 4)

    def test_a_miss_is_not_counted_twice(self) -> None:
        self._post({"text": "Once."})
        snap = self.engine.metrics.snapshot()
        self.assertEqual(snap["received"], 1)
        self.assertEqual(snap["cache_hits"], 0)
        self.assertEqual(snap["collapsed"], 0)

    def test_bypass_is_a_render_not_a_cache_serve(self) -> None:
        self.client.post(
            "/v1/text-to-speech/alba", params={"output_format": "wav_24000"},
            json={"text": "Skip it."}, headers={"Cache-Control": "no-store"})
        snap = self.engine.metrics.snapshot()
        self.assertEqual(snap["cache_hits"], 0)
        self.assertEqual(snap["collapsed"], 0)
        self.assertEqual(snap["received"], 1, "the bypass rendered, so submit counted it")


class AggregatedMetricKeysAreRealTests(unittest.TestCase):
    """No field in ``replicas.AGG_KEYS`` may be structurally zero.

    Summing a counter nothing ever increments across N replicas produces a
    confident zero, which is worse than an absent field.
    """

    def test_every_agg_key_has_a_production_writer(self) -> None:
        import re
        from pathlib import Path

        from service import replicas

        src = Path(replicas.__file__).parent
        production = "\n".join(
            p.read_text(encoding="utf-8")
            for p in sorted(src.glob("*.py")))  # service/*.py only, never tests
        # A counter is "real" if production CALLS the Metrics method that owns
        # it. The leading "." makes these call patterns, so the `def` line in
        # engine.py (which has no dot) can never satisfy one on its own.
        writers = {
            "cache_hits": r"\.on_cache_hit\(",
            "collapsed": r"\.on_collapsed\(",
            "received": r"\.on_received\(",
            "rejected_429": r"\.on_rejected\(",
            "errored": r"\.on_error\(",
            "timeouts": r"\.on_timeout\(",
            "abandoned": r"\.on_abandoned\(",
            "completed": r"\.on_finish\(",
            "audio_seconds_total": r"\.on_finish\(",
            "in_flight": r"\.job_running\(",
            "queued": r"\.on_enqueue\(",
        }
        for key in replicas.AGG_KEYS:
            with self.subTest(key=key):
                pattern = writers.get(key)
                self.assertIsNotNone(
                    pattern, f"AGG_KEYS gained {key!r} with no known writer — "
                             f"add it here (and make sure it HAS one)")
                self.assertTrue(
                    re.search(pattern, production),
                    f"{key!r} is aggregated across replicas but nothing in "
                    f"production ever increments it — it sums to a confident 0")


class SingleFlightTests(_Base):
    def test_concurrent_identical_requests_collapse_to_one_synthesis(self) -> None:
        async def _drive():
            return await asyncio.gather(*[
                appmod.text_to_speech("alba", TTSRequest(text="Stampede."),
                                      output_format="wav_24000", emotion=None)
                for _ in range(5)])

        responses = asyncio.run(_drive())
        self.assertEqual(len(self.engine.jobs), 1,
                         "5 identical concurrent requests took 5 worker permits")
        bodies = {bytes(r.body) for r in responses}
        self.assertEqual(len(bodies), 1)
        caches = sorted(r.headers["x-cache"] for r in responses)
        self.assertEqual(caches, ["hit", "hit", "hit", "hit", "miss"])
        self.assertEqual(appmod.SYNTH_CACHE.stats()["collapsed"], 4)

    def test_leader_failure_is_shared_not_cached(self) -> None:
        # The failed render must not poison the cache: a later request retries.
        self.engine.close()
        self.engine = fake_engine.FakeEngine(workers=2, delay=0.01,
                                             errors={"Boom.": "kaboom"})
        appmod.ENGINE = self.engine
        client = TestClient(appmod.app, raise_server_exceptions=False)
        first = client.post("/v1/text-to-speech/alba",
                            params={"output_format": "wav_24000"},
                            json={"text": "Boom."})
        self.assertEqual(first.status_code, 500)
        self.assertEqual(appmod.SYNTH_CACHE.stats()["entries"], 0)
        second = client.post("/v1/text-to-speech/alba",
                             params={"output_format": "wav_24000"},
                             json={"text": "Boom."})
        self.assertEqual(second.status_code, 500)
        self.assertEqual(len(self.engine.jobs), 2, "failure must not be cached")


class InvalidationTests(_Base):
    def test_recloned_voice_never_serves_stale_audio(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            appmod.SETTINGS = dataclasses.replace(appmod.SETTINGS,
                                                  voices_dir=tmp)
            path = os.path.join(tmp, "cloney.safetensors")
            with open(path, "wb") as fh:
                fh.write(b"v1")
            first = self._post({"text": "Whose voice?"}, voice="cloney")
            self.assertEqual(first.headers["x-cache"], "miss")
            self.assertEqual(self._post({"text": "Whose voice?"},
                                        voice="cloney").headers["x-cache"], "hit")
            # Re-clone: same voice id, different bytes.
            with open(path, "wb") as fh:
                fh.write(b"v2-longer-embedding")
            after = self._post({"text": "Whose voice?"}, voice="cloney")
            self.assertEqual(after.headers["x-cache"], "miss")
            self.assertEqual(len(self.engine.jobs), 2)

    def test_disabled_cache_never_hits(self) -> None:
        appmod.SYNTH_CACHE.resize(0)
        self._post({"text": "No cache."})
        resp = self._post({"text": "No cache."})
        self.assertEqual(resp.headers["x-cache"], "miss")
        self.assertEqual(len(self.engine.jobs), 2)

    def test_budget_evicts_and_the_evicted_entry_re_renders(self) -> None:
        # One fake clip is 524 bytes; a 900-byte budget holds one.
        appmod.SYNTH_CACHE.resize(900)
        self._post({"text": "First clip."})
        self._post({"text": "Second clip."})   # evicts the first
        self.assertEqual(appmod.SYNTH_CACHE.stats()["entries"], 1)
        self.assertGreaterEqual(appmod.SYNTH_CACHE.stats()["evictions"], 1)
        again = self._post({"text": "First clip."})
        self.assertEqual(again.headers["x-cache"], "miss")


class SynthCacheUnitTests(unittest.TestCase):
    """The store itself, away from HTTP."""

    @staticmethod
    def _audio(nbytes: int) -> CachedAudio:
        return CachedAudio(wav_bytes=b"x" * nbytes, sample_rate=24000,
                           audio_seconds=1.0)

    def test_lru_eviction_respects_the_byte_budget(self) -> None:
        cache = SynthCache(250)
        cache.put("a", self._audio(100))
        cache.put("b", self._audio(100))
        cache.get("a")                      # 'a' is now most-recently-used
        cache.put("c", self._audio(100))    # over budget -> evict 'b'
        self.assertIsNotNone(cache.get("a"))
        self.assertIsNone(cache.get("b"))
        self.assertIsNotNone(cache.get("c"))
        self.assertEqual(cache.stats()["bytes"], 200)
        self.assertEqual(cache.stats()["evictions"], 1)

    def test_entry_larger_than_the_budget_is_not_admitted(self) -> None:
        # Admitting it would evict everything and then itself.
        cache = SynthCache(100)
        cache.put("a", self._audio(50))
        cache.put("huge", self._audio(500))
        self.assertIsNone(cache.get("huge"))
        self.assertIsNotNone(cache.get("a"))

    def test_cancelled_leader_lets_a_follower_take_over(self) -> None:
        # A leader whose caller hangs up must not fail — or wedge — the others.
        cache = SynthCache(1024)
        started = asyncio.Event()
        calls = []

        async def _slow():
            calls.append("call")
            started.set()
            await asyncio.sleep(10)
            return SynthCacheUnitTests._audio(10)

        async def _fast():
            calls.append("call")
            return SynthCacheUnitTests._audio(10)

        async def _drive():
            leader = asyncio.create_task(cache.get_or_synthesize("k", _slow))
            await started.wait()
            follower = asyncio.create_task(cache.get_or_synthesize("k", _fast))
            await asyncio.sleep(0)  # let the follower park on the flight
            leader.cancel()
            value, cached = await asyncio.wait_for(follower, timeout=1.0)
            return value, cached

        value, cached = asyncio.run(_drive())
        self.assertEqual(value.nbytes, 10)
        self.assertFalse(cached)          # it did the work itself
        self.assertEqual(len(calls), 2)   # slow leader + the new leader
        self.assertEqual(cache.stats()["in_flight"], 0)


if __name__ == "__main__":
    unittest.main()
