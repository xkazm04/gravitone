"""Traffic-shape tests: arrivals are a real Poisson process, corpora are varied.

Pure over the module's two cores -- no server, no torch -- except the last
class, which fires the generated corpus at the real app with a fake engine to
prove the cache-defeat claim is about the shipped server, not just about the
generator's own bookkeeping.
"""
from __future__ import annotations

import unittest

from service import workload as wl


class ArrivalScheduleTests(unittest.TestCase):
    def test_mean_rate_is_the_requested_rate(self) -> None:
        # ~10k arrivals: the sample mean of a Poisson process is tight enough
        # that 5% is a generous band, and a broken generator misses it wildly.
        offsets = wl.arrival_schedule(20.0, 500.0, seed=1)
        stats = wl.schedule_stats(offsets, 500.0)
        self.assertAlmostEqual(stats["mean_rate_rps"], 20.0, delta=1.0)
        self.assertAlmostEqual(stats["mean_interarrival_s"], 1 / 20.0, delta=0.005)

    def test_rate_scales(self) -> None:
        slow = wl.arrival_schedule(2.0, 300.0, seed=7)
        fast = wl.arrival_schedule(8.0, 300.0, seed=7)
        self.assertGreater(len(fast), 3 * len(slow))

    def test_offsets_are_ascending_and_inside_the_window(self) -> None:
        offsets = wl.arrival_schedule(5.0, 30.0, seed=3)
        self.assertTrue(all(b > a for a, b in zip(offsets, offsets[1:])))
        self.assertLess(offsets[-1], 30.0)
        self.assertGreater(offsets[0], 0.0)

    def test_deterministic_per_seed(self) -> None:
        a = wl.arrival_schedule(5.0, 60.0, seed=42)
        b = wl.arrival_schedule(5.0, 60.0, seed=42)
        c = wl.arrival_schedule(5.0, 60.0, seed=43)
        self.assertEqual(a, b)          # replayable run
        self.assertNotEqual(a, c)       # and genuinely random per seed

    def test_arrivals_are_not_evenly_spaced(self) -> None:
        # A fixed-interval "rate" is the bug this replaces: real callers bunch.
        gaps = [b - a for a, b in zip(*(lambda o: (o, o[1:]))(
            wl.arrival_schedule(10.0, 200.0, seed=5)))]
        self.assertGreater(max(gaps), 4 * (sum(gaps) / len(gaps)))

    def test_bad_arguments_are_refused(self) -> None:
        with self.assertRaises(ValueError):
            wl.arrival_schedule(0.0, 10.0)
        with self.assertRaises(ValueError):
            wl.arrival_schedule(1.0, 0.0)


class CorpusTests(unittest.TestCase):
    def test_profiles_have_distinct_lengths(self) -> None:
        def words(profile):
            return sum(len(wl.corpus_sample(profile, seed=s).split())
                       for s in range(20)) / 20.0

        self.assertLess(words("short"), words("typical"))
        self.assertLess(words("typical"), words("long"))

    def test_deterministic_per_seed(self) -> None:
        self.assertEqual(wl.corpus_sample("typical", 11),
                         wl.corpus_sample("typical", 11))
        self.assertNotEqual(wl.corpus_sample("typical", 11),
                            wl.corpus_sample("typical", 12))

    def test_unknown_profile_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            wl.corpus_sample("enormous", 1)

    def test_mixed_draws_from_every_bucket(self) -> None:
        lengths = {len(wl.corpus_sample("mixed", s).split()) for s in range(80)}
        self.assertGreater(max(lengths), 3 * min(lengths))

    def test_series_is_pairwise_distinct_by_construction(self) -> None:
        # THE cache-defeat guarantee: no two requests in a run share a body,
        # so no request can be answered from the synthesis cache.
        for profile in ("short", "typical", "long", "mixed"):
            texts = wl.corpus_series(profile, 200, seed=2)
            self.assertEqual(len(texts), 200)
            self.assertEqual(len(set(texts)), 200, profile)

    def test_series_is_deterministic(self) -> None:
        self.assertEqual(wl.corpus_series("typical", 25, seed=9),
                         wl.corpus_series("typical", 25, seed=9))

    def test_series_refuses_to_repeat_itself(self) -> None:
        # Better a loud failure than duplicate bodies silently measuring cache.
        cap = wl.corpus_capacity("short")
        self.assertGreater(cap, 100)
        with self.assertRaises(ValueError):
            wl.corpus_series("short", cap + 1)

    def test_corpus_carries_no_personal_data(self) -> None:
        # In-repo snippets only: no addresses, no emails, no phone numbers.
        blob = " ".join(s for pool in wl.SNIPPETS.values() for s in pool)
        for marker in ("@", "http", "+1", "password", "SSN"):
            self.assertNotIn(marker, blob)


class CorpusDefeatsTheServerCacheTests(unittest.TestCase):
    """The generated corpus reaches the ENGINE with the cache fully enabled.

    ``--cache-mode bypass`` asks the server nicely; a varied corpus does not
    need to ask. This fires generated bodies at the real app with NO bypass
    headers and asserts every one of them rendered.
    """

    def setUp(self) -> None:
        from service.tests import fake_engine  # installs shims before app import
        import service.app as appmod
        from fastapi.testclient import TestClient

        self.appmod = appmod
        self._orig_engine = appmod.ENGINE
        appmod.SYNTH_CACHE.clear()
        appmod.SYNTH_CACHE.resize(8 * 1024 * 1024)   # cache ON, as shipped
        self.engine = fake_engine.FakeEngine(workers=2, delay=0.01)
        appmod.ENGINE = self.engine
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        self.engine.close()
        self.appmod.ENGINE = self._orig_engine
        self.appmod.SYNTH_CACHE.clear()
        self.appmod.SYNTH_CACHE.resize(self.appmod.SETTINGS.cache_bytes)

    def _fire(self, text):
        return self.client.post(
            "/v1/text-to-speech/alba", params={"output_format": "wav_24000"},
            json={"text": text, "model_id": "pocket_tts"})

    def test_every_generated_body_renders_even_without_bypass_headers(self) -> None:
        for text in wl.corpus_series("typical", 5, seed=4):
            r = self._fire(text)
            self.assertEqual(r.status_code, 200)
            self.assertNotEqual((r.headers.get("x-cache") or "").lower(), "hit")
        self.assertEqual(len(self.engine.jobs), 5)

    def test_the_old_constant_corpus_is_a_cache_hit(self) -> None:
        # Proves the guard above tests something real (this IS the old bug).
        from service import loadtest as lt
        for _ in range(3):
            self.assertEqual(self._fire(lt.TEXT_DEFAULT).status_code, 200)
        self.assertEqual(len(self.engine.jobs), 1)


if __name__ == "__main__":
    unittest.main()
