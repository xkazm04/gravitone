"""Load-tester pure-logic tests.

The ramp itself needs a live server, but the reporting/schema logic is pure and
must be right (two runs are only comparable if the JSON is self-describing).
These exercise that logic with no server and no torch import.
"""
from __future__ import annotations

import unittest

from service import loadtest as lt


# ---------------------------------------------------------------------------
# Direction 3 — comparable, versioned, warmed results
# ---------------------------------------------------------------------------
class ReproMetadataTests(unittest.TestCase):
    def test_git_sha_is_a_string(self) -> None:
        sha = lt.git_sha()
        self.assertIsInstance(sha, str)
        self.assertTrue(sha)  # never empty — "unknown" on failure

    def test_runtime_metadata_shape(self) -> None:
        meta = lt.runtime_metadata()
        self.assertEqual(meta["schema_version"], 3)
        self.assertIn("git_sha", meta)
        self.assertIn("torch_version", meta)          # None when torch absent
        self.assertIn("onednn_fpmath_mode", meta)     # None when env unset

    def test_onednn_mode_read_from_env(self) -> None:
        import os
        prev = os.environ.get("ONEDNN_DEFAULT_FPMATH_MODE")
        os.environ["ONEDNN_DEFAULT_FPMATH_MODE"] = "bf16"
        try:
            self.assertEqual(lt.runtime_metadata()["onednn_fpmath_mode"], "bf16")
        finally:
            if prev is None:
                del os.environ["ONEDNN_DEFAULT_FPMATH_MODE"]
            else:
                os.environ["ONEDNN_DEFAULT_FPMATH_MODE"] = prev


class SampleSizeTests(unittest.TestCase):
    def test_requests_per_level_is_computed_once_for_all(self) -> None:
        # busiest level (8) sets the floor so every level draws equal samples
        self.assertEqual(lt.requests_per_level(12, [1, 2, 4, 8]), 12)
        self.assertEqual(lt.requests_per_level(4, [1, 2, 4, 16]), 16)
        self.assertEqual(lt.requests_per_level(20, []), 20)

    def test_mark_low_confidence_flags_small_populations(self) -> None:
        small = lt.mark_low_confidence({"ok": 5})
        self.assertTrue(small["low_confidence"])
        big = lt.mark_low_confidence({"ok": 40})
        self.assertNotIn("low_confidence", big)
        edge = lt.mark_low_confidence({"ok": lt.LOW_CONFIDENCE_N})
        self.assertNotIn("low_confidence", edge)  # exactly threshold is fine


class BuildResultTests(unittest.TestCase):
    def _meta(self) -> dict:
        return {"schema_version": 3, "git_sha": "abc1234",
                "torch_version": "2.4.0", "onednn_fpmath_mode": "bf16"}

    def test_result_is_self_describing(self) -> None:
        res = lt.build_result(
            rows=[{"concurrency": 1, "ok": 12}], knee=None, recommended=1,
            route="synth", fmt="wav_24000", corpus="hello world",
            service_config={"workers": 1, "queue_max": 16}, meta=self._meta())
        self.assertEqual(res["schema_version"], 3)
        self.assertEqual(res["git_sha"], "abc1234")
        self.assertEqual(res["torch_version"], "2.4.0")
        self.assertEqual(res["onednn_fpmath_mode"], "bf16")
        self.assertEqual(res["route"], "synth")
        self.assertEqual(res["format"], "wav_24000")
        self.assertEqual(res["corpus"], "hello world")
        self.assertEqual(res["service_config"]["queue_max"], 16)
        self.assertEqual(res["levels"][0]["concurrency"], 1)
        self.assertIsNone(res["knee"])
        self.assertEqual(res["recommended_cap"], 1)

    def test_extra_block_is_merged(self) -> None:
        res = lt.build_result(
            rows=[], knee=None, recommended=None, route="synth",
            fmt="wav_24000", corpus="x", service_config={}, meta=self._meta(),
            extra={"topology": {"mode": "single"}})
        self.assertEqual(res["topology"]["mode"], "single")


# ---------------------------------------------------------------------------
# The benchmark must measure the ENGINE, not the synthesis cache
# ---------------------------------------------------------------------------
class CacheModeTests(unittest.TestCase):
    def test_bypass_is_the_default(self) -> None:
        # An operator who never heard of the cache must still get honest numbers.
        self.assertEqual(lt.DEFAULT_CACHE_MODE, "bypass")
        h = lt.request_headers()
        self.assertEqual(h.get("Cache-Control"), "no-store")
        self.assertEqual(h.get("X-Gravitone-Cache"), "bypass")

    def test_allow_mode_sends_no_bypass_headers(self) -> None:
        self.assertEqual(lt.request_headers("allow"), {})

    def test_cli_default_is_bypass(self) -> None:
        # The flag itself, as argparse will see it — a default flipped by
        # accident is exactly the regression this direction exists to stop.
        import argparse
        ap = argparse.ArgumentParser()
        ap.add_argument("--cache-mode", choices=lt.CACHE_MODES,
                        default=lt.DEFAULT_CACHE_MODE)
        self.assertEqual(ap.parse_args([]).cache_mode, "bypass")

    def test_measurement_block_is_honest_about_hits(self) -> None:
        clean = lt.measurement_block([{"cache_hits": 0}, {"cache_hits": 0}], "bypass")
        self.assertTrue(clean["measures_synthesis"])
        self.assertEqual(clean["cache_hits_total"], 0)

        dirty = lt.measurement_block([{"cache_hits": 0}, {"cache_hits": 7}], "bypass")
        self.assertFalse(dirty["measures_synthesis"])
        self.assertEqual(dirty["cache_hits_total"], 7)
        self.assertIn("cache", dirty["note"])

        allowed = lt.measurement_block([{"cache_hits": 0}], "allow")
        self.assertFalse(allowed["measures_synthesis"])  # cache was permitted

    def test_result_carries_the_measurement_claim(self) -> None:
        res = lt.build_result(
            rows=[{"concurrency": 1, "ok": 12, "cache_hits": 0}], knee=None,
            recommended=1, route="synth", fmt="wav_24000", corpus="x",
            service_config={}, meta=lt.runtime_metadata(), cache_mode="bypass")
        self.assertEqual(res["cache_mode"], "bypass")
        self.assertTrue(res["measurement"]["measures_synthesis"])

    def test_cache_hit_response_is_counted_not_averaged(self) -> None:
        # A hit reports X-Realtime-Factor: n/a (see app.py), so nothing fake
        # reaches results["rtf"] — but the sample IS tallied as contamination.
        import asyncio

        class _Resp:
            status_code = 200
            headers = {"X-Cache": "hit", "X-Realtime-Factor": "n/a",
                       "X-Audio-Seconds": "3.0"}

        class _Client:
            async def post(self, *a, **k):
                return _Resp()

        results = {"lat": [], "ttfb": [], "rtf": [], "audio": [], "rejected": 0,
                   "errors": 0, "timeouts": 0, "unsupported": 0, "cache_hits": 0}
        asyncio.run(lt._one(_Client(), "http://x", "v", "hi", "wav_24000",
                            results, lt.request_headers()))
        self.assertEqual(results["cache_hits"], 1)
        self.assertEqual(results["errors"], 0)
        self.assertNotEqual(results["rtf"][0], results["rtf"][0])  # nan, dropped


class BenchmarkReachesTheModelTests(unittest.TestCase):
    """The load test's OWN request, against the real app + a fake engine.

    This is the regression guard: the harness fires one constant text at every
    level, so if the server ever serves those requests from its synthesis cache
    again, the whole ramp measures an LRU lookup and this fails.
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

    def _fire(self, headers):
        return self.client.post(
            "/v1/text-to-speech/alba", params={"output_format": "wav_24000"},
            json={"text": lt.TEXT_DEFAULT, "model_id": "pocket_tts"},
            headers=headers)

    def test_harness_headers_make_every_request_reach_the_engine(self) -> None:
        headers = lt.request_headers()          # the default the harness sends
        for _ in range(3):
            r = self._fire(headers)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.headers["x-cache"], "bypass")
        self.assertEqual(len(self.engine.jobs), 3,
                         "the benchmark corpus was served from cache — the ramp "
                         "would measure an LRU lookup, not synthesis")
        # A bypassed run must not pollute the cache real callers share.
        self.assertEqual(self.appmod.SYNTH_CACHE.stats()["entries"], 0)
        self.assertEqual(self.appmod.SYNTH_CACHE.stats()["bypassed"], 3)

    def test_without_the_headers_the_same_corpus_is_a_cache_hit(self) -> None:
        # Proves the guard above is testing something real (this IS the bug).
        for _ in range(3):
            self.assertEqual(self._fire({}).status_code, 200)
        self.assertEqual(len(self.engine.jobs), 1)

    def test_a_cache_hit_never_reports_a_realtime_factor(self) -> None:
        self._fire({})
        hit = self._fire({})
        self.assertEqual(hit.headers["x-cache"], "hit")
        self.assertEqual(hit.headers["x-realtime-factor"], "n/a")


# ---------------------------------------------------------------------------
# Direction 1 — benchmark the topology we actually ship (service.replicas)
# ---------------------------------------------------------------------------
class ReplicasLaunchTests(unittest.TestCase):
    def test_launch_command_reuses_the_real_cli(self) -> None:
        cmd = lt.replicas_launch_command(4, 8080, 9080, host="127.0.0.1",
                                         python="py")
        self.assertEqual(cmd[:3], ["py", "-m", "service.replicas"])
        self.assertIn("--replicas", cmd)
        self.assertIn("4", cmd)
        self.assertIn("--port", cmd)
        self.assertIn("8080", cmd)
        self.assertIn("--metrics-port", cmd)
        self.assertIn("9080", cmd)
        self.assertIn("127.0.0.1", cmd)

    def test_default_metrics_port_matches_launcher(self) -> None:
        self.assertEqual(lt.default_metrics_port(8080), 9080)


class MetricsDeltaTests(unittest.TestCase):
    def test_delta_over_pool_totals_incl_timeouts_abandoned(self) -> None:
        before = {"received": 10, "completed": 8, "timeouts": 1, "abandoned": 2,
                  "in_flight": 1, "queued": 0, "rejected_429": 0, "errored": 0}
        after = {"received": 30, "completed": 26, "timeouts": 3, "abandoned": 5,
                 "in_flight": 0, "queued": 1, "rejected_429": 2, "errored": 1}
        d = lt.metrics_delta(before, after)
        self.assertEqual(d["received"], 20)
        self.assertEqual(d["completed"], 18)
        self.assertEqual(d["timeouts"], 2)      # counter present in the delta
        self.assertEqual(d["abandoned"], 3)      # counter present in the delta
        self.assertEqual(d["rejected_429"], 2)
        self.assertEqual(d["errored"], 1)

    def test_missing_or_nonnumeric_counters_are_skipped(self) -> None:
        # An empty "before" (e.g. scrape failed) yields no spurious negatives.
        d = lt.metrics_delta({}, {"received": 5, "completed": "n/a"})
        self.assertNotIn("received", d)   # no matching 'before' value
        self.assertNotIn("completed", d)  # non-numeric

    def test_topology_block_shape(self) -> None:
        per_level = [{"concurrency": 1, "pool_delta": {"received": 12}}]
        block = lt.topology_block("replicas", 4, per_level)
        self.assertEqual(block["mode"], "replicas")
        self.assertEqual(block["replicas"], 4)
        self.assertEqual(block["aggregated_metrics_per_level"], per_level)


class ScrapePoolTotalsTests(unittest.TestCase):
    """The scrape helper must isolate the ramp from a flaky metrics port."""

    def test_unreachable_metrics_port_returns_empty(self) -> None:
        import asyncio
        # Nothing is listening on this port -> httpx raises -> {} (not a crash).
        totals = asyncio.run(lt._scrape_pool_totals("http://127.0.0.1:1/metrics"))
        self.assertEqual(totals, {})


# ---------------------------------------------------------------------------
# Direction 2 — streaming TTFB (time-to-first-chunk)
# ---------------------------------------------------------------------------
class StreamTimingTests(unittest.TestCase):
    def _drive(self, chunks):
        """Feed (delay, bytes) pairs through a fake async byte iterator using a
        virtual clock, so timing is deterministic (no real sleeps)."""
        import asyncio

        clock = {"t": 0.0}

        async def aiter():
            for delay, data in chunks:
                clock["t"] += delay
                yield data

        return asyncio.run(
            lt._measure_stream_timing(aiter(), t0=0.0, clock=lambda: clock["t"]))

    def test_ttfb_is_time_to_first_nonempty_chunk(self) -> None:
        # header flush is empty, then first audio at t=0.05, tail chunks later
        ttfb, total = self._drive(
            [(0.02, b""), (0.03, b"AUDIO0"), (0.40, b"AUDIO1"), (0.40, b"AUDIO2")])
        # first NON-EMPTY chunk lands at 0.02 + 0.03 = 0.05
        self.assertAlmostEqual(ttfb, 0.05, places=6)
        # total drains the whole stream (0.85), far past first chunk
        self.assertAlmostEqual(total, 0.85, places=6)
        self.assertLess(ttfb, total)

    def test_ttfb_none_when_no_bytes(self) -> None:
        ttfb, total = self._drive([(0.1, b""), (0.1, b"")])
        self.assertIsNone(ttfb)          # nothing to time to
        self.assertAlmostEqual(total, 0.2, places=6)


class StreamRequestTests(unittest.TestCase):
    """_one_stream classifies status codes and records TTFB via a fake client."""

    class _FakeStreamResp:
        def __init__(self, status, chunks=()):
            self.status_code = status
            self._chunks = chunks

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def aiter_bytes(self):
            for c in self._chunks:
                yield c

    class _FakeClient:
        def __init__(self, resp):
            self._resp = resp

        def stream(self, *a, **k):
            return self._resp

    def _run(self, status, chunks=()):
        import asyncio
        results = {"lat": [], "ttfb": [], "rtf": [], "audio": [],
                   "rejected": 0, "errors": 0, "timeouts": 0, "unsupported": 0}
        client = self._FakeClient(self._FakeStreamResp(status, chunks))
        asyncio.run(lt._one_stream(client, "http://x", "v", "hi", "wav_24000", results))
        return results

    def test_200_records_ttfb_and_total(self) -> None:
        r = self._run(200, chunks=[b"", b"AUDIO", b"MORE"])
        self.assertEqual(len(r["lat"]), 1)
        self.assertEqual(len(r["ttfb"]), 1)   # a first chunk was timed
        self.assertEqual(r["errors"], 0)

    def test_501_is_surfaced_as_unsupported_not_error(self) -> None:
        r = self._run(501)
        self.assertEqual(r["unsupported"], 1)  # mp3-on-stream, clearly flagged
        self.assertEqual(r["errors"], 0)
        self.assertEqual(len(r["lat"]), 0)

    def test_429_counts_as_rejected(self) -> None:
        r = self._run(429)
        self.assertEqual(r["rejected"], 1)
        self.assertEqual(r["errors"], 0)

    def test_504_counts_as_timeout_not_error(self) -> None:
        r = self._run(504)
        self.assertEqual(r["timeouts"], 1)   # distinct timeout bucket
        self.assertEqual(r["errors"], 0)
        self.assertEqual(len(r["lat"]), 0)


# ---------------------------------------------------------------------------
# Honest measurement accounting: 504 timeouts + server/driver CPU split
# ---------------------------------------------------------------------------
class ClassifyResponseTests(unittest.TestCase):
    def test_status_buckets(self) -> None:
        self.assertEqual(lt.classify_response(200), "ok")
        self.assertEqual(lt.classify_response(429), "rejected")
        self.assertEqual(lt.classify_response(504), "timeout")   # its OWN bucket
        self.assertEqual(lt.classify_response(500), "error")
        self.assertEqual(lt.classify_response(503), "error")


class LevelDegradedTests(unittest.TestCase):
    def _row(self, **kw):
        base = {"rejected_429": 0, "timeouts": 0, "errors": 0,
                "lat_p95_s": 1.0, "cpu_mean_pct": 10.0, "server_rtf_mean": 2.0}
        base.update(kw)
        return base

    def test_clean_level_is_not_degraded(self) -> None:
        self.assertFalse(lt.level_degraded(self._row(), 1.0, 2.0, 95.0))

    def test_any_timeout_degrades_like_an_error(self) -> None:
        self.assertTrue(lt.level_degraded(self._row(timeouts=1), 1.0, 2.0, 95.0))

    def test_any_429_degrades(self) -> None:
        self.assertTrue(lt.level_degraded(self._row(rejected_429=1), 1.0, 2.0, 95.0))

    def test_any_error_degrades(self) -> None:
        self.assertTrue(lt.level_degraded(self._row(errors=1), 1.0, 2.0, 95.0))

    def test_p95_blowup_degrades(self) -> None:
        # p95 5.0 vs baseline 1.0 with factor 2.0 -> degraded
        self.assertTrue(lt.level_degraded(self._row(lat_p95_s=5.0), 1.0, 2.0, 95.0))

    def test_cpu_saturated_and_slower_than_realtime_degrades(self) -> None:
        row = self._row(cpu_mean_pct=99.0, server_rtf_mean=0.5)
        self.assertTrue(lt.level_degraded(row, 1.0, 2.0, 95.0))

    def test_cpu_high_but_realtime_ok_is_not_degraded(self) -> None:
        row = self._row(cpu_mean_pct=99.0, server_rtf_mean=1.5)
        self.assertFalse(lt.level_degraded(row, 1.0, 2.0, 95.0))


class _FakeProc:
    """Minimal psutil.Process stand-in for the CPU-split tests."""

    def __init__(self, cpu, children=(), raise_on_cpu=False):
        self._cpu = cpu
        self._children = list(children)
        self._raise = raise_on_cpu

    def cpu_percent(self, interval=None):
        if self._raise:
            raise RuntimeError("process gone")
        return self._cpu

    def children(self, recursive=False):
        return self._children


class CpuSplitTests(unittest.TestCase):
    def test_proc_tree_sums_root_and_descendants(self) -> None:
        proc = _FakeProc(50.0, children=[_FakeProc(30.0), _FakeProc(20.0)])
        self.assertEqual(lt._proc_tree_cpu(proc), 100.0)

    def test_proc_tree_none_when_no_proc(self) -> None:
        self.assertIsNone(lt._proc_tree_cpu(None))

    def test_proc_tree_none_when_root_gone(self) -> None:
        self.assertIsNone(lt._proc_tree_cpu(_FakeProc(0.0, raise_on_cpu=True)))

    def test_proc_tree_skips_a_reaped_child(self) -> None:
        # A child that vanishes mid-sample is skipped, not fatal.
        proc = _FakeProc(40.0, children=[_FakeProc(0.0, raise_on_cpu=True),
                                         _FakeProc(10.0)])
        self.assertEqual(lt._proc_tree_cpu(proc), 50.0)

    def test_cpu_stats_mean_and_max(self) -> None:
        self.assertEqual(lt._cpu_stats([10.0, 20.0, 30.0]), (20.0, 30.0))

    def test_cpu_stats_empty_is_none(self) -> None:
        self.assertEqual(lt._cpu_stats([]), (None, None))

    def test_driver_saturation_threshold(self) -> None:
        self.assertTrue(lt.is_driver_saturated(90.0))    # exactly the line
        self.assertTrue(lt.is_driver_saturated(150.0))
        self.assertFalse(lt.is_driver_saturated(89.9))
        self.assertFalse(lt.is_driver_saturated(None))   # no driver sample

    def test_cpu_accounting_note_reflects_pid_presence(self) -> None:
        with_pid = lt.cpu_accounting_note(1234)
        self.assertIn("server_cpu_", with_pid)
        self.assertIn("driver_cpu_", with_pid)
        without = lt.cpu_accounting_note(None)
        self.assertIn("host-only", without)
        self.assertIn("--server-pid", without)


class SingleServerMetricsScrapeTests(unittest.TestCase):
    def test_unreachable_metrics_returns_empty(self) -> None:
        import asyncio
        totals = asyncio.run(lt._scrape_server_metrics("http://127.0.0.1:1/metrics"))
        self.assertEqual(totals, {})


if __name__ == "__main__":
    unittest.main()
