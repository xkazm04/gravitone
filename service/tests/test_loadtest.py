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
        self.assertEqual(meta["schema_version"], 2)
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
        return {"schema_version": 2, "git_sha": "abc1234",
                "torch_version": "2.4.0", "onednn_fpmath_mode": "bf16"}

    def test_result_is_self_describing(self) -> None:
        res = lt.build_result(
            rows=[{"concurrency": 1, "ok": 12}], knee=None, recommended=1,
            route="synth", fmt="wav_24000", corpus="hello world",
            service_config={"workers": 1, "queue_max": 16}, meta=self._meta())
        self.assertEqual(res["schema_version"], 2)
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


if __name__ == "__main__":
    unittest.main()
