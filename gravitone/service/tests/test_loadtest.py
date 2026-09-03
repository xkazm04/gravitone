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

    def test_delta_includes_audio_seconds_total(self) -> None:
        d = lt.metrics_delta({"audio_seconds_total": 10.0},
                             {"audio_seconds_total": 42.5})
        self.assertEqual(d["audio_seconds_total"], 32.5)

    def test_topology_block_states_what_its_counters_are(self) -> None:
        per_level = [{"concurrency": 1, "scope": lt.SCOPE_SAMPLE,
                      "counter_delta": {"received": 12}}]
        block = lt.topology_block("replicas", 4, per_level, lt.SCOPE_SAMPLE)
        self.assertEqual(block["mode"], "replicas")
        self.assertEqual(block["replicas"], 4)
        self.assertEqual(block["metrics_per_level"], per_level)
        # The shipped SO_REUSEPORT topology cannot substantiate a pool total,
        # so the block must not imply one.
        self.assertEqual(block["metrics_scope"], lt.SCOPE_SAMPLE)
        self.assertIn("NOT pool totals", block["metrics_scope_note"])
        self.assertNotIn("aggregated_metrics_per_level", block)

    def test_pool_total_scope_is_labelled_too(self) -> None:
        block = lt.topology_block("replicas", 4, [], lt.SCOPE_POOL_TOTAL)
        self.assertEqual(block["metrics_scope"], lt.SCOPE_POOL_TOTAL)
        self.assertIn("summed", block["metrics_scope_note"])


class ScrapeScopeTests(unittest.TestCase):
    """The harness must carry the launcher's honesty flag, not flatten it."""

    def _serve(self, doc):
        """Run a one-shot HTTP server returning ``doc`` and scrape it."""
        import asyncio
        import json
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        body = json.dumps(doc).encode()

        class _H(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        srv = HTTPServer(("127.0.0.1", 0), _H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{srv.server_port}/metrics"
            return asyncio.run(lt._scrape_pool_metrics(url))
        finally:
            srv.shutdown()

    def test_pool_total_is_read_as_a_total(self) -> None:
        got = self._serve({"scope": "pool_total",
                           "totals": {"received": 40, "audio_seconds_total": 9.5}})
        self.assertEqual(got["scope"], lt.SCOPE_POOL_TOTAL)
        self.assertEqual(got["counters"]["received"], 40)

    def test_reuse_port_sample_is_read_as_a_sample(self) -> None:
        got = self._serve({"scope": "single_replica_sample", "totals": None,
                           "sample": {"received": 10}, "note": "..."})
        self.assertEqual(got["scope"], lt.SCOPE_SAMPLE)
        self.assertEqual(got["counters"]["received"], 10)

    def test_unreachable_metrics_port_reports_unknown_scope(self) -> None:
        import asyncio
        got = asyncio.run(lt._scrape_pool_metrics("http://127.0.0.1:1/metrics"))
        self.assertEqual(got, {"scope": lt.SCOPE_UNKNOWN, "counters": {}})


class ScrapePoolTotalsTests(unittest.TestCase):
    """The scrape helper must isolate the ramp from a flaky metrics port."""

    def test_unreachable_metrics_port_returns_empty(self) -> None:
        import asyncio
        # Nothing is listening -> httpx raises -> empty counters (not a crash).
        got = asyncio.run(lt._scrape_pool_metrics("http://127.0.0.1:1/metrics"))
        self.assertEqual(got["counters"], {})


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
        got = asyncio.run(lt._scrape_server_metrics("http://127.0.0.1:1/metrics"))
        self.assertEqual(got, {"scope": lt.SCOPE_UNKNOWN, "counters": {}})


# ---------------------------------------------------------------------------
# SLO capacity contract — open-loop arrivals, breaker, SLO knee
# ---------------------------------------------------------------------------
class ArrivalModeTests(unittest.TestCase):
    def test_closed_loop_stays_the_default(self) -> None:
        # The concurrency ramp is what every existing script/CI invocation
        # expects; open-loop must be opted into, never inherited.
        self.assertEqual(lt.DEFAULT_ARRIVAL, "closed")
        import argparse
        ap = argparse.ArgumentParser()
        ap.add_argument("--arrival", choices=lt.ARRIVAL_MODES,
                        default=lt.DEFAULT_ARRIVAL)
        self.assertEqual(ap.parse_args([]).arrival, "closed")

    def test_parse_rates(self) -> None:
        self.assertEqual(lt.parse_rates("2,4,6.5"), [2.0, 4.0, 6.5])
        self.assertEqual(lt.parse_rates("6, 2 ,2"), [2.0, 6.0])   # sorted, dedup
        self.assertEqual(lt.parse_rates("0,-3"), [])              # positives only
        self.assertEqual(lt.parse_rates(4), [4.0])

    def test_corpus_description_names_the_generated_workload(self) -> None:
        import argparse
        closed = argparse.Namespace(arrival="closed", text="one sentence")
        self.assertEqual(lt.corpus_description(closed), "one sentence")
        openl = argparse.Namespace(arrival="poisson", text="one sentence",
                                   corpus_profile="mixed", seed=7)
        desc = lt.corpus_description(openl)
        self.assertIn("mixed", desc)
        self.assertIn("seed=7", desc)
        self.assertIn("distinct body", desc)


class AdmissionGateTests(unittest.TestCase):
    """The breaker must refuse-and-count, never queue — and never melt the box."""

    def test_refuses_past_the_ceiling_and_counts_refusals(self) -> None:
        gate = lt.AdmissionGate(2)
        self.assertTrue(gate.try_acquire())
        self.assertTrue(gate.try_acquire())
        self.assertFalse(gate.try_acquire())   # ceiling reached -> refused
        self.assertFalse(gate.try_acquire())
        self.assertEqual(gate.refused, 2)
        self.assertEqual(gate.in_flight, 2)
        self.assertEqual(gate.peak_in_flight, 2)

    def test_release_frees_a_slot(self) -> None:
        gate = lt.AdmissionGate(1)
        self.assertTrue(gate.try_acquire())
        self.assertFalse(gate.try_acquire())
        gate.release()
        self.assertTrue(gate.try_acquire())
        self.assertEqual(gate.refused, 1)

    def test_peak_is_remembered_after_release(self) -> None:
        gate = lt.AdmissionGate(8)
        for _ in range(5):
            gate.try_acquire()
        for _ in range(5):
            gate.release()
        self.assertEqual(gate.in_flight, 0)
        self.assertEqual(gate.peak_in_flight, 5)

    def test_zero_disables_the_breaker(self) -> None:
        gate = lt.AdmissionGate(0)
        for _ in range(200):
            self.assertTrue(gate.try_acquire())
        self.assertEqual(gate.refused, 0)


class SloArithmeticTests(unittest.TestCase):
    def test_violation_rate(self) -> None:
        self.assertEqual(lt.violation_rate([0.5, 1.0, 3.0, 4.0], 2.0), 0.5)
        self.assertEqual(lt.violation_rate([0.5, 1.0], 2.0), 0.0)
        self.assertIsNone(lt.violation_rate([], 2.0))     # nothing succeeded
        self.assertIsNone(lt.violation_rate([1.0], None))  # no SLO declared

    def test_queue_wait_is_little_law_over_sampled_depth(self) -> None:
        # depth p95 = 10 items, goodput 5/s -> ~2s of waiting
        self.assertEqual(lt.queue_wait_p95_s([0, 2, 4, 10], 5.0), 2.0)
        self.assertIsNone(lt.queue_wait_p95_s([], 5.0))
        self.assertIsNone(lt.queue_wait_p95_s([3], 0))     # no goodput, no wait

    def test_concurrent_users_is_rate_times_think_time(self) -> None:
        self.assertEqual(lt.concurrent_users(7.4, 30.0), 222)
        self.assertEqual(lt.concurrent_users(7.4, 5.0), 37)   # assumption drives it
        self.assertIsNone(lt.concurrent_users(None, 30.0))
        self.assertIsNone(lt.concurrent_users(4.0, 0))


class SloPredicateTests(unittest.TestCase):
    def _row(self, **kw):
        base = {"offered_rate_rps": 4.0, "rejected_429": 0, "timeouts": 0,
                "errors": 0, "lat_p95_s": 1.0, "slo_violation_rate": 0.0,
                "cpu_mean_pct": 99.0, "server_rtf_mean": 0.4}
        base.update(kw)
        return base

    def test_slo_replaces_the_relative_rules(self) -> None:
        # CPU pinned and sub-realtime — the fallback rules would call this
        # degraded, but the users are being served inside the promise.
        row = self._row()
        self.assertTrue(lt.level_degraded(row, 1.0, 2.0, 95.0))
        self.assertFalse(lt.level_degraded(row, 1.0, 2.0, 95.0, slo_p95=2.0,
                                           slo_violations_max=0.01))

    def test_p95_over_the_slo_degrades(self) -> None:
        row = self._row(lat_p95_s=2.5)
        self.assertTrue(lt.level_degraded(row, None, 2.0, 95.0, slo_p95=2.0))

    def test_violation_budget_is_enforced(self) -> None:
        row = self._row(slo_violation_rate=0.05)
        self.assertTrue(lt.level_degraded(row, None, 2.0, 95.0, slo_p95=2.0,
                                          slo_violations_max=0.01))
        self.assertFalse(lt.level_degraded(row, None, 2.0, 95.0, slo_p95=2.0,
                                           slo_violations_max=0.10))

    def test_a_level_with_no_successes_never_meets_an_slo(self) -> None:
        row = self._row(lat_p95_s=None)
        self.assertTrue(lt.level_degraded(row, None, 2.0, 95.0, slo_p95=2.0))

    def test_breaker_refusals_degrade_the_level(self) -> None:
        # The driver had to protect the box: the rate was NOT sustained.
        row = self._row(refused_in_flight=3)
        self.assertTrue(lt.level_degraded(row, None, 2.0, 95.0, slo_p95=2.0))
        self.assertTrue(lt.level_degraded(row, 1.0, 2.0, 95.0))

    def test_hard_failures_still_degrade_under_an_slo(self) -> None:
        for bad in ("rejected_429", "timeouts", "errors"):
            row = self._row(**{bad: 1})
            self.assertTrue(lt.level_degraded(row, None, 2.0, 95.0, slo_p95=2.0),
                            bad)


class SloKneeTests(unittest.TestCase):
    def _row(self, rate, p95, **kw):
        row = {"offered_rate_rps": rate, "lat_p95_s": p95, "rejected_429": 0,
               "timeouts": 0, "errors": 0, "slo_violation_rate": 0.0}
        row.update(kw)
        return row

    def test_knee_is_the_highest_rate_meeting_the_slo(self) -> None:
        rows = [self._row(2, 0.8), self._row(4, 1.2), self._row(6, 3.0)]
        self.assertEqual(lt.slo_knee(rows, 2.0, 0.01), (4, 6))

    def test_a_pass_above_a_failure_is_not_counted(self) -> None:
        # Passing at 8 after failing at 6 is luck (or too short a run), not
        # capacity: the contract stops at the first failure.
        rows = [self._row(2, 0.8), self._row(6, 3.0), self._row(8, 1.0)]
        sustained, first_fail = lt.slo_knee(rows, 2.0, 0.01)
        self.assertEqual(sustained, 2)
        self.assertEqual(first_fail, 6)

    def test_no_rate_meets_the_slo(self) -> None:
        rows = [self._row(2, 5.0), self._row(4, 6.0)]
        self.assertEqual(lt.slo_knee(rows, 2.0, 0.01), (None, 2))

    def test_recommended_cap_is_peak_in_flight_at_the_sustained_rate(self) -> None:
        rows = [self._row(2, 0.8, peak_in_flight=3),
                self._row(4, 1.2, peak_in_flight=9),
                self._row(4, 1.3, peak_in_flight=11, soak=True)]
        slo = {"max_rate_rps": 4}
        self.assertEqual(lt.open_loop_recommended_cap(rows, slo), 9)
        self.assertIsNone(lt.open_loop_recommended_cap(rows, {"max_rate_rps": None}))


class OpenLoopRowTests(unittest.TestCase):
    def _results(self, lats, **kw):
        r = {"lat": list(lats), "ttfb": [], "rtf": [2.0] * len(lats),
             "audio": [3.0] * len(lats), "rejected": 0, "errors": 0,
             "timeouts": 0, "unsupported": 0, "cache_hits": 0}
        r.update(kw)
        return r

    def test_row_reports_offered_goodput_violations_and_refusals(self) -> None:
        row = lt.open_loop_row(
            offered_rate=4.0, duration_s=10.0, scheduled=40, refused=4,
            results=self._results([0.5] * 30 + [3.0] * 6), wall_s=10.0,
            samples={"cpu": [50.0], "mem": [40.0]},
            queue_depths=[0, 5, 10], slo_p95=2.0, slo_violations_max=0.01,
            peak_in_flight=12)
        self.assertEqual(row["arrival"], "poisson")
        self.assertEqual(row["offered_rate_rps"], 4.0)
        self.assertEqual(row["scheduled"], 40)
        self.assertEqual(row["fired"], 36)
        self.assertEqual(row["refused_in_flight"], 4)
        self.assertEqual(row["ok"], 36)
        self.assertEqual(row["goodput_req_s"], 3.6)
        self.assertAlmostEqual(row["slo_violation_rate"], 6 / 36, places=3)
        self.assertEqual(row["queue_depth_p95"], 10)
        self.assertEqual(row["queue_wait_p95_s"], round(10 / 3.6, 4))
        # concurrency is DISCOVERED here, not configured -- say so.
        self.assertEqual(row["peak_in_flight"], 12)
        self.assertEqual(row["concurrency"], 12)
        self.assertEqual(row["cpu_mean_pct"], 50.0)
        self.assertTrue(row["measures_synthesis"])

    def test_row_is_judged_by_the_slo_predicate(self) -> None:
        good = lt.open_loop_row(offered_rate=4.0, duration_s=10.0, scheduled=40,
                                refused=0, results=self._results([0.5] * 40),
                                wall_s=10.0, slo_p95=2.0)
        self.assertFalse(lt.level_degraded(good, None, 2.0, 95.0, slo_p95=2.0,
                                           slo_violations_max=0.01))
        slow = lt.open_loop_row(offered_rate=8.0, duration_s=10.0, scheduled=80,
                                refused=0, results=self._results([5.0] * 80),
                                wall_s=10.0, slo_p95=2.0)
        self.assertTrue(lt.level_degraded(slow, None, 2.0, 95.0, slo_p95=2.0,
                                          slo_violations_max=0.01))

    def test_low_confidence_still_applies(self) -> None:
        row = lt.open_loop_row(offered_rate=0.5, duration_s=10.0, scheduled=5,
                               refused=0, results=self._results([0.5] * 5),
                               wall_s=10.0, slo_p95=2.0)
        self.assertTrue(row["low_confidence"])


class HonestyBlockTests(unittest.TestCase):
    def test_workload_block_carries_the_idle_box_warning_and_breaker_state(self) -> None:
        rows = [{"refused_in_flight": 0}, {"refused_in_flight": 5,
                                           "driver_saturated": True}]
        block = lt.workload_block(rates=[2, 4], duration_s=60.0, seed=1,
                                  profile="typical", max_in_flight=64, rows=rows)
        self.assertEqual(block["arrival"], "poisson")
        self.assertEqual(block["refused_in_flight_total"], 5)
        self.assertTrue(block["breaker_tripped"])
        self.assertTrue(block["driver_saturated_any"])
        self.assertTrue(block["corpus_distinct_bodies"])
        self.assertIn("IDLE box", block["idle_box_warning"])
        self.assertIn("cache", block["corpus_note"])

    def test_slo_block_states_the_promise(self) -> None:
        blk = lt.slo_block(slo_p95=2.0, violations_max=0.01, max_rate=7.4,
                           first_fail=8.0, soak_minutes=30, soak_ok=True,
                           think_time_s=30.0)
        self.assertEqual(blk["max_rate_rps"], 7.4)
        self.assertEqual(blk["concurrent_users"], 222)
        self.assertIn("think_time_s", blk["concurrent_users_basis"])
        self.assertFalse(blk["predicted"])

    def test_a_failed_soak_withdraws_the_claim(self) -> None:
        # Reachable for a minute is not sustainable for thirty.
        blk = lt.slo_block(slo_p95=2.0, violations_max=0.01, max_rate=7.4,
                           first_fail=8.0, soak_minutes=30, soak_ok=False)
        self.assertIsNone(blk["max_rate_rps"])
        self.assertIsNone(blk["concurrent_users"])
        self.assertEqual(blk["candidate_rate_rps"], 7.4)
        self.assertIn("not sustainable", blk["note"])

    def test_no_rate_found_makes_no_promise(self) -> None:
        blk = lt.slo_block(slo_p95=2.0, violations_max=0.01, max_rate=None,
                           first_fail=2.0, soak_minutes=0, soak_ok=None)
        self.assertIsNone(blk["max_rate_rps"])
        self.assertIn("no offered rate met the SLO", blk["note"])


class OpenLoopDriverTests(unittest.TestCase):
    """The defining behaviour: arrivals do NOT wait for in-flight work.

    Driven against a fake httpx client (no server, no sockets), because the
    difference between open and closed loop is entirely in the driver.
    """

    class _Resp:
        status_code = 200
        headers = {"X-Realtime-Factor": "2.0", "X-Audio-Seconds": "3.0"}

    class _FakeClient:
        """Every request takes ``delay`` seconds, so a slow server is simulated."""

        def __init__(self, delay=0.4, **kw):
            self.delay = delay

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **k):
            import asyncio
            await asyncio.sleep(self.delay)
            return OpenLoopDriverTests._Resp()

    def _args(self, **kw):
        import argparse
        base = dict(url="http://x", voice="v", format="wav_24000", route="synth",
                    cache_mode="bypass", server_pid=None, max_in_flight=64,
                    corpus_profile="typical", slo_p95=2.0,
                    slo_violations_max=0.01, text=lt.TEXT_DEFAULT)
        base.update(kw)
        return argparse.Namespace(**base)

    def _run(self, args, rate, duration):
        import asyncio
        from unittest import mock
        with mock.patch.object(lt.httpx, "AsyncClient", self._FakeClient):
            return asyncio.run(lt.run_open_loop(args, rate, duration, seed=1))

    def test_requests_overlap_because_arrivals_ignore_in_flight_work(self) -> None:
        # 20 req/s of 0.4s-long requests: a closed loop would peak at 1 in
        # flight; open loop must pile them up (that IS queueing appearing).
        row = self._run(self._args(), rate_rps := 20.0, 1.0)
        self.assertGreater(row["peak_in_flight"], 3)
        self.assertEqual(row["refused_in_flight"], 0)
        self.assertGreater(row["ok"], 5)
        self.assertEqual(row["errors"], 0)
        self.assertEqual(row["offered_rate_rps"], rate_rps)
        self.assertIsNotNone(row["goodput_req_s"])

    def test_max_in_flight_is_a_hard_refusal_not_a_wait(self) -> None:
        row = self._run(self._args(max_in_flight=2), 20.0, 1.0)
        self.assertLessEqual(row["peak_in_flight"], 2)
        self.assertGreater(row["refused_in_flight"], 0)
        # A level that needed the breaker did not sustain its offered rate.
        self.assertTrue(lt.level_degraded(row, None, 2.0, 95.0, slo_p95=2.0))

    def test_every_request_carries_its_own_body(self) -> None:
        sent = []

        class _Recording(OpenLoopDriverTests._FakeClient):
            async def post(self, *a, **k):
                sent.append(k["json"]["text"])
                return await super().post(*a, **k)

        import asyncio
        from unittest import mock
        with mock.patch.object(lt.httpx, "AsyncClient", _Recording):
            asyncio.run(lt.run_open_loop(self._args(), 10.0, 1.0, seed=3))
        self.assertGreater(len(sent), 3)
        self.assertEqual(len(set(sent)), len(sent))   # cache defeated by design
        self.assertNotIn(lt.TEXT_DEFAULT, sent)

    def test_an_exhausted_corpus_refuses_instead_of_repeating(self) -> None:
        # 'short' cannot supply thousands of distinct bodies: fail loudly.
        row = self._run(self._args(corpus_profile="short"), 300.0, 5.0)
        self.assertIsNone(row)


if __name__ == "__main__":
    unittest.main()
