"""Direction 3 — replica-native launcher.

Exercises the launcher's pure logic and its supervision without ever spawning a
real uvicorn/model process: subprocess is replaced by a fake, the clock is
injected, and the metrics aggregator is fed stubbed replica responses.
"""
from __future__ import annotations

import json
import logging
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from service import replicas as rep

# Keep the supervisor's restart/shutdown log lines out of the test output.
rep.logger.setLevel(logging.CRITICAL)


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------
class _FakeProc:
    def __init__(self, graceful_on_terminate: bool = False) -> None:
        self._returncode = None
        self.graceful = graceful_on_terminate
        self.terminated = 0
        self.killed = 0
        self.waited: list = []

    def poll(self):
        return self._returncode

    def terminate(self):
        self.terminated += 1
        if self.graceful:
            self._returncode = 0

    def kill(self):
        self.killed += 1
        self._returncode = -9

    def wait(self, timeout=None):
        self.waited.append(timeout)
        return self._returncode

    def die(self, code: int = 1):
        self._returncode = code


class _FakeSpawn:
    def __init__(self, graceful: bool = False) -> None:
        self.calls: list = []
        self.procs: list = []
        self.graceful = graceful

    def __call__(self, cmd, **kwargs):
        p = _FakeProc(graceful_on_terminate=self.graceful)
        self.calls.append((cmd, kwargs))
        self.procs.append(p)
        return p


class _Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------
class PureHelperTests(unittest.TestCase):
    def test_per_replica_threads(self) -> None:
        self.assertEqual(rep.per_replica_threads(4, 16), 4)
        self.assertEqual(rep.per_replica_threads(3, 12), 4)
        self.assertEqual(rep.per_replica_threads(8, 4), 1)   # never below 1
        self.assertEqual(rep.per_replica_threads(0, 8), 8)   # guards div-by-zero

    def test_replica_env_pins_workers_and_threads(self) -> None:
        env = rep.replica_env(4, 16, base={"EXISTING": "keep"})
        self.assertEqual(env["EXISTING"], "keep")
        self.assertEqual(env["TTS_WORKERS"], "1")
        for var in ("TTS_TORCH_THREADS", "OMP_NUM_THREADS",
                    "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
            self.assertEqual(env[var], "4")

    def test_replica_env_tells_the_child_how_many_share_a_budget(self) -> None:
        # Without this the per-IP limiter counts alone in each process and the
        # pool quietly spends N budgets (service/ratelimit.py).
        self.assertEqual(rep.replica_env(4, 16, base={})["TTS_REPLICAS"], "4")
        self.assertEqual(rep.replica_env(1, 4, base={})["TTS_REPLICAS"], "1")

    def test_replica_env_sets_onednn_bf16_fastmath(self) -> None:
        # It used to live ONLY in the Dockerfile, so a bare-metal replica run
        # silently lost the biggest Neoverse inference lever. oneDNN reads this
        # at import, so only the launcher can set it.
        env = rep.replica_env(2, 8, base={})
        self.assertEqual(env[rep.FPMATH_ENV_VAR], rep.FPMATH_DEFAULT)

    def test_replica_env_respects_an_explicit_fpmath_override(self) -> None:
        env = rep.replica_env(2, 8, base={rep.FPMATH_ENV_VAR: "any"})
        self.assertEqual(env[rep.FPMATH_ENV_VAR], "any")

    def test_serving_ports(self) -> None:
        self.assertEqual(rep.serving_ports(8000, 3, reuse_port=True), [8000, 8000, 8000])
        self.assertEqual(rep.serving_ports(8000, 3, reuse_port=False), [8000, 8001, 8002])

    def test_replica_command_sequential(self) -> None:
        cmd = rep.replica_command(8001, reuse_port=False, host="0.0.0.0")
        self.assertIn("service.app:app", cmd)
        self.assertIn("--workers", cmd)
        self.assertIn("--port", cmd)
        self.assertIn("8001", cmd)
        self.assertNotIn("--fd", cmd)

    def test_replica_command_reuse_port_uses_fd(self) -> None:
        cmd = rep.replica_command(8000, reuse_port=True, fd=7)
        self.assertIn("--fd", cmd)
        self.assertIn("7", cmd)
        self.assertNotIn("--port", cmd)

    def test_replica_command_reuse_port_requires_fd(self) -> None:
        with self.assertRaises(ValueError):
            rep.replica_command(8000, reuse_port=True, fd=None)

    def test_metrics_targets_sequential_ports_are_per_replica(self) -> None:
        seq = rep.metrics_targets("0.0.0.0", 8000, 2, reuse_port=False)
        self.assertEqual(seq, [(0, "http://127.0.0.1:8000/metrics"),
                               (1, "http://127.0.0.1:8001/metrics")])
        self.assertEqual(rep.metrics_scope(False), rep.SCOPE_POOL_TOTAL)

    def test_metrics_targets_under_reuse_port_is_one_unlabelled_scrape(self) -> None:
        # This used to return the SAME url N times, and the aggregator summed
        # the results — N random samples of one arbitrary replica added into a
        # "pool total". Under SO_REUSEPORT there is exactly one thing we can
        # scrape and we cannot say which replica answered: one target, index
        # None, and a scope that forbids summing.
        shared = rep.metrics_targets("0.0.0.0", 8000, 4, reuse_port=True)
        self.assertEqual(shared, [(None, "http://127.0.0.1:8000/metrics")])
        self.assertEqual(rep.metrics_scope(True), rep.SCOPE_SAMPLE)

    def test_backoff_delay_is_bounded_and_grows(self) -> None:
        self.assertEqual(rep.backoff_delay(0), 0.5)
        self.assertEqual(rep.backoff_delay(1), 1.0)
        self.assertEqual(rep.backoff_delay(2), 2.0)
        self.assertEqual(rep.backoff_delay(100), 30.0)  # capped


# ---------------------------------------------------------------------------
# Metrics aggregation
# ---------------------------------------------------------------------------
class AggregateMetricsTests(unittest.TestCase):
    def test_sums_totals_across_replicas(self) -> None:
        responses = {
            "u0": {"metrics": {"received": 10, "completed": 8, "in_flight": 1,
                               "queued": 2, "rejected_429": 1, "errored": 0,
                               "timeouts": 0, "abandoned": 3}},
            "u1": {"metrics": {"received": 5, "completed": 5, "in_flight": 0,
                               "queued": 0, "rejected_429": 0, "errored": 2,
                               "timeouts": 1, "abandoned": 1}},
        }
        res = rep.aggregate_metrics([(0, "u0"), (1, "u1")],
                                    fetch=lambda u: responses[u],
                                    scope=rep.SCOPE_POOL_TOTAL)
        self.assertEqual(res["scope"], rep.SCOPE_POOL_TOTAL)
        self.assertTrue(res["complete"])
        t = res["totals"]
        self.assertEqual(t["received"], 15)
        self.assertEqual(t["completed"], 13)
        self.assertEqual(t["in_flight"], 1)
        self.assertEqual(t["queued"], 2)
        self.assertEqual(t["errored"], 2)
        self.assertEqual(t["timeouts"], 1)
        self.assertEqual(t["abandoned"], 4)
        self.assertEqual(len(res["replicas"]), 2)
        self.assertTrue(all(r["ok"] for r in res["replicas"]))

    def test_unreachable_replica_is_skipped_not_fatal(self) -> None:
        def fetch(url):
            if url == "bad":
                raise ConnectionError("refused")
            return {"metrics": {"received": 7}}

        res = rep.aggregate_metrics([(0, "ok"), (1, "bad")], fetch=fetch)
        self.assertEqual(res["totals"]["received"], 7)   # only the good one
        # A partial scrape yields a real but INCOMPLETE total; say so.
        self.assertEqual(res["replicas_reporting"], 1)
        self.assertEqual(res["replicas_expected"], 2)
        self.assertFalse(res["complete"])
        self.assertTrue(res["replicas"][0]["ok"])
        self.assertFalse(res["replicas"][1]["ok"])
        self.assertIn("error", res["replicas"][1])

    def test_audio_seconds_total_is_summed(self) -> None:
        # Additive, float, and what the studio's savings ticker reads — it was
        # missing from AGG_KEYS, so a pool reported one replica's audio.
        responses = {"u0": {"metrics": {"audio_seconds_total": 12.5}},
                     "u1": {"metrics": {"audio_seconds_total": 7.25}}}
        res = rep.aggregate_metrics([(0, "u0"), (1, "u1")],
                                    fetch=lambda u: responses[u])
        self.assertEqual(res["totals"]["audio_seconds_total"], 19.75)

    def test_reuse_port_scope_refuses_to_publish_a_total(self) -> None:
        # THE bug this direction fixes: under SO_REUSEPORT the aggregate must
        # not present itself as a pool figure.
        calls = []

        def fetch(url):
            calls.append(url)
            return {"metrics": {"received": 10, "completed": 9,
                                "audio_seconds_total": 4.0}}

        res = rep.aggregate_metrics(
            rep.metrics_targets("0.0.0.0", 8000, 4, reuse_port=True),
            fetch=fetch, scope=rep.metrics_scope(True), replicas_expected=4)
        self.assertEqual(len(calls), 1)           # scraped once, not 4x
        self.assertEqual(res["scope"], rep.SCOPE_SAMPLE)
        self.assertIsNone(res["totals"])          # no fake pool number at all
        self.assertEqual(res["sample"]["received"], 10)
        self.assertEqual(res["replicas_expected"], 4)
        self.assertIn("SO_REUSEPORT", res["note"])

    def test_sample_scope_survives_an_unreachable_replica(self) -> None:
        def fetch(url):
            raise ConnectionError("refused")

        res = rep.aggregate_metrics([(None, "shared")], fetch=fetch,
                                    scope=rep.SCOPE_SAMPLE, replicas_expected=2)
        self.assertIsNone(res["totals"])
        self.assertIsNone(res["sample"])
        self.assertEqual(res["replicas_reporting"], 0)

    def test_accepts_bare_metrics_dict(self) -> None:
        res = rep.aggregate_metrics([(0, "u")],
                                    fetch=lambda u: {"received": 4, "completed": 4})
        self.assertEqual(res["totals"]["received"], 4)


# ---------------------------------------------------------------------------
# Supervision
# ---------------------------------------------------------------------------
class SupervisorTests(unittest.TestCase):
    def _make(self, graceful: bool = False):
        spawn = _FakeSpawn(graceful=graceful)
        clock = _Clock()
        sup = rep.ReplicaSupervisor(
            replicas=3, port=8000, host="127.0.0.1", reuse_port=False,
            cores=12, spawn=spawn, clock=clock)
        return sup, spawn, clock

    def test_start_spawns_n_with_pinned_env_and_ports(self) -> None:
        sup, spawn, _ = self._make()
        sup.start()
        self.assertEqual(len(spawn.calls), 3)
        for i, (cmd, kwargs) in enumerate(spawn.calls):
            env = kwargs["env"]
            self.assertEqual(env["TTS_WORKERS"], "1")
            self.assertEqual(env["TTS_TORCH_THREADS"], "4")   # 12 // 3
            self.assertEqual(env["OMP_NUM_THREADS"], "4")
            self.assertEqual(env["TTS_PORT"], str(8000 + i))
            # sequential mode -> distinct --port per replica, no shared fd.
            self.assertIn(str(8000 + i), cmd)
            self.assertNotIn("pass_fds", kwargs)

    def test_dead_replica_restarts_after_backoff(self) -> None:
        sup, spawn, clock = self._make()
        sup.start()
        self.assertEqual(len(spawn.calls), 3)

        # Replica 1 dies.
        sup.replicas[1].proc.die()

        # First tick notices the death and schedules a backoff window; it does
        # NOT respawn immediately.
        clock.t = 0.0
        sup.check_once()
        self.assertEqual(len(spawn.calls), 3)
        self.assertEqual(sup.replicas[1].consecutive_failures, 1)
        self.assertAlmostEqual(sup.replicas[1].next_restart_at, 0.5)

        # Before the window elapses: still no respawn.
        clock.t = 0.3
        sup.check_once()
        self.assertEqual(len(spawn.calls), 3)

        # After the window: respawned exactly once.
        clock.t = 0.6
        sup.check_once()
        self.assertEqual(len(spawn.calls), 4)
        self.assertIsNot(sup.replicas[1].proc, spawn.procs[1])  # a fresh proc

    def test_healthy_uptime_resets_failure_streak(self) -> None:
        sup, spawn, clock = self._make()
        sup.start()
        sup.replicas[0].consecutive_failures = 2
        sup.replicas[0].started_at = 0.0
        clock.t = sup.HEALTHY_UPTIME_S + 1
        sup.check_once()  # replica 0 is alive and has been up long enough
        self.assertEqual(sup.replicas[0].consecutive_failures, 0)

    def test_shutdown_fans_sigterm_to_all(self) -> None:
        sup, spawn, _ = self._make(graceful=True)
        sup.start()
        sup.shutdown(grace_s=1.0)
        for p in spawn.procs:
            self.assertEqual(p.terminated, 1)
            self.assertEqual(p.killed, 0)  # exited gracefully on SIGTERM

    def test_shutdown_kills_stubborn_replicas(self) -> None:
        sup, spawn, _ = self._make(graceful=False)
        sup.start()
        sup.shutdown(grace_s=0.0)
        for p in spawn.procs:
            self.assertEqual(p.terminated, 1)
            self.assertEqual(p.killed, 1)  # ignored SIGTERM -> SIGKILL

    def test_check_once_is_noop_while_shutting_down(self) -> None:
        sup, spawn, _ = self._make()
        sup.start()
        sup._shutting_down = True
        sup.replicas[0].proc.die()
        sup.check_once()
        self.assertEqual(len(spawn.calls), 3)  # no restart during shutdown


class AggKeysContractTests(unittest.TestCase):
    """replicas.AGG_KEYS hand-copies the engine's additive counter names.

    That copy is deliberate — the supervisor is stdlib-only and must never
    import service.engine (it would drag torch + scipy into the launcher
    process). But nothing at runtime notices when the two drift: a renamed or
    added engine counter would just silently stop being summed into the pool's
    /metrics, with no error. The TEST env can import both sides, so pin the
    contract here.
    """

    # Integer snapshot fields that are GAUGES, not additive counters: summing
    # them across replicas would be meaningless, so they are deliberately absent
    # from AGG_KEYS. Anything new must be classified on purpose — that's the
    # point of this test, not an exemption list to grow thoughtlessly.
    NON_ADDITIVE_INTS = {"window_size"}  # length of the latency sample window
    # Percentiles and ratios: averaging/summing them across replicas is
    # meaningless (they are None on a fresh Metrics(), hence the explicit list).
    NON_ADDITIVE_FLOATS = {"latency_p50_s", "latency_p95_s", "latency_p99_s",
                           "synth_p50_s", "realtime_factor"}

    def test_agg_keys_match_engine_metrics_snapshot(self) -> None:
        from service.tests import fake_engine  # noqa: F401  (installs dep shims)
        from service.engine import Metrics

        snap = Metrics().snapshot()
        int_fields = {k for k, v in snap.items()
                      if isinstance(v, int) and not isinstance(v, bool)}

        unclassified = int_fields - set(rep.AGG_KEYS) - self.NON_ADDITIVE_INTS
        self.assertEqual(
            unclassified, set(),
            f"engine.Metrics.snapshot() emits integer field(s) {sorted(unclassified)} that "
            f"replicas.AGG_KEYS does not sum, so the aggregated pool /metrics silently "
            f"under-reports them. Either add them to AGG_KEYS (it cannot import engine — "
            f"stdlib-only supervisor) or list them in NON_ADDITIVE_INTS if they are gauges.")

        # Floats too: audio_seconds_total is additive and was missed for years
        # because this test only walked integers.
        float_fields = {k for k, v in snap.items() if isinstance(v, float)}
        unclassified_floats = (float_fields - set(rep.AGG_KEYS)
                               - self.NON_ADDITIVE_FLOATS)
        self.assertEqual(
            unclassified_floats, set(),
            f"engine.Metrics.snapshot() emits float field(s) {sorted(unclassified_floats)} "
            f"that replicas.AGG_KEYS does not sum. Add them to AGG_KEYS if additive, "
            f"or to NON_ADDITIVE_FLOATS if they are averages/percentiles.")

        stale = set(rep.AGG_KEYS) - set(snap)
        self.assertEqual(
            stale, set(),
            f"replicas.AGG_KEYS sums {sorted(stale)}, which engine.Metrics.snapshot() no "
            f"longer emits — renamed or removed upstream. Update AGG_KEYS.")


# ---------------------------------------------------------------------------
# Fabric: addressability (admin ports)
# ---------------------------------------------------------------------------
class AdminAddressabilityTests(unittest.TestCase):
    def test_admin_ports_are_sequential_in_both_port_modes(self) -> None:
        # THE point of the admin port: a replica has an address of its own even
        # when the kernel is load-balancing a shared client port.
        self.assertEqual(rep.admin_ports(10000, 3), [10000, 10001, 10002])

    def test_admin_targets_are_loopback_only(self) -> None:
        for _, url in rep.admin_targets(10000, 2):
            self.assertTrue(url.startswith("http://127.0.0.1:"), url)
        self.assertEqual(rep.introspect_targets(10000, 1),
                         [(0, "http://127.0.0.1:10000/introspect")])

    def test_admin_base_retires_the_single_sample_caveat(self) -> None:
        # Reuse-port mode used to be unsummable. With admin ports there are N
        # addressable targets, so the total is real.
        targets = rep.metrics_targets("0.0.0.0", 8000, 3, reuse_port=True,
                                      admin_base=10000)
        self.assertEqual([i for i, _ in targets], [0, 1, 2])
        self.assertEqual(rep.metrics_scope(True, admin=True), rep.SCOPE_POOL_TOTAL)
        self.assertEqual(rep.metrics_scope(False, admin=True), rep.SCOPE_POOL_TOTAL)

    def test_honest_sample_label_survives_where_it_is_still_true(self) -> None:
        # --no-admin + SO_REUSEPORT: nothing changed, and it must still say so.
        self.assertEqual(rep.metrics_scope(True, admin=False), rep.SCOPE_SAMPLE)
        self.assertEqual(rep.metrics_targets("0.0.0.0", 8000, 4, reuse_port=True),
                         [(None, "http://127.0.0.1:8000/metrics")])

    def test_replica_command_without_admin_port_is_unchanged(self) -> None:
        self.assertEqual(rep.replica_command(8001, reuse_port=False),
                         rep.replica_command(8001, reuse_port=False,
                                             admin_port=None))

    def test_replica_command_with_admin_port_uses_the_child_entrypoint(self) -> None:
        cmd = rep.replica_command(8001, reuse_port=False, admin_port=10001)
        self.assertIn("service.replicas", cmd)
        self.assertIn("--child", cmd)
        self.assertIn("--admin-port", cmd)
        self.assertIn("10001", cmd)
        self.assertIn("8001", cmd)

    def test_child_command_under_reuse_port_still_inherits_the_fd(self) -> None:
        cmd = rep.replica_command(8000, reuse_port=True, fd=9, admin_port=10000)
        self.assertIn("--fd", cmd)
        self.assertIn("9", cmd)
        self.assertNotIn("--port", cmd)
        with self.assertRaises(ValueError):
            rep.replica_command(8000, reuse_port=True, admin_port=10000)

    def test_supervisor_assigns_an_admin_port_per_replica(self) -> None:
        sup = rep.ReplicaSupervisor(replicas=3, port=8000, reuse_port=True,
                                    cores=6, spawn=_FakeSpawn(), clock=_Clock())
        self.assertEqual([r.admin_port for r in sup.replicas],
                         [10000, 10001, 10002])
        self.assertEqual([r.port for r in sup.replicas], [8000, 8000, 8000])
        self.assertEqual(sup.introspect_url(1),
                         "http://127.0.0.1:10001/introspect")

    def test_no_admin_restores_the_plain_uvicorn_child(self) -> None:
        spawn = _FakeSpawn()
        sup = rep.ReplicaSupervisor(replicas=1, port=8000, reuse_port=False,
                                    cores=4, spawn=spawn, clock=_Clock(),
                                    admin=False)
        sup.start()
        cmd, kwargs = spawn.calls[0]
        self.assertIn("uvicorn", cmd)
        self.assertNotIn("--child", cmd)
        self.assertNotIn("TTS_ADMIN_PORT", kwargs["env"])
        self.assertIsNone(sup.introspect_url(0))


# ---------------------------------------------------------------------------
# Fabric: introspection
# ---------------------------------------------------------------------------
class _FakeMetrics:
    def __init__(self, **counters) -> None:
        self._c = counters
        self.counter_calls = 0
        self.snapshot_calls = 0

    def counters(self) -> dict:
        self.counter_calls += 1
        return dict(self._c)

    def snapshot(self) -> dict:
        self.snapshot_calls += 1
        return dict(self._c)


class _FakeEngine:
    def __init__(self, permits=2, live=1, queued=0, in_flight=0, voices=None) -> None:
        self.metrics = _FakeMetrics(queued=queued, in_flight=in_flight)
        self.live_workers = live
        self.ready = True
        self.draining = False
        self._permits = permits
        if voices is not None:
            self.voice_lru_keys = lambda: list(voices)

    def available_permits(self) -> int:
        return self._permits

    def config(self) -> dict:
        return {"workers": 1}


class IntrospectDocTests(unittest.TestCase):
    def test_reports_capacity(self) -> None:
        doc = rep.introspect_doc(_FakeEngine(permits=3, live=2, queued=5,
                                             in_flight=1), index=2)
        self.assertEqual(doc["replica"], 2)
        self.assertEqual(doc["available_permits"], 3)
        self.assertEqual(doc["live_workers"], 2)
        self.assertEqual(doc["queue_depth"], 5)
        self.assertEqual(doc["in_flight"], 1)

    def test_uses_cheap_counters_never_the_percentile_snapshot(self) -> None:
        # /introspect is polled in a drain loop on a saturated box; snapshot()
        # sorts the latency windows.
        eng = _FakeEngine()
        rep.introspect_doc(eng)
        self.assertEqual(eng.metrics.snapshot_calls, 0)
        self.assertEqual(eng.metrics.counter_calls, 1)

    def test_voice_keys_omitted_until_the_engine_exposes_them(self) -> None:
        # Absent key != empty list: a consumer must be able to tell "no hot
        # voices" from "this build cannot tell you".
        self.assertNotIn("voice_lru_keys", rep.introspect_doc(_FakeEngine()))
        doc = rep.introspect_doc(_FakeEngine(voices=["b", "a", "a"]))
        self.assertEqual(doc["voice_lru_keys"], ["a", "b"])

    def test_a_broken_metrics_call_degrades_instead_of_raising(self) -> None:
        eng = _FakeEngine()
        eng.metrics.counters = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
        doc = rep.introspect_doc(eng)
        self.assertIsNone(doc["queue_depth"])
        self.assertEqual(doc["available_permits"], 2)


class AggregateIntrospectionTests(unittest.TestCase):
    def _fetch(self, responses):
        def fetch(url):
            value = responses[url]
            if isinstance(value, Exception):
                raise value
            return value
        return fetch

    def test_folds_replicas_into_one_pool_document(self) -> None:
        responses = {
            "a": {"live_workers": 1, "available_permits": 2, "queue_depth": 3,
                  "in_flight": 1, "voice_lru_keys": ["nova"]},
            "b": {"live_workers": 1, "available_permits": 0, "queue_depth": 7,
                  "in_flight": 2, "voice_lru_keys": ["nova", "atlas"]},
        }
        doc = rep.aggregate_introspection([(0, "a"), (1, "b")],
                                          fetch=self._fetch(responses))
        self.assertEqual(doc["totals"], {"live_workers": 2, "available_permits": 2,
                                         "queue_depth": 10, "in_flight": 3})
        self.assertTrue(doc["complete"])
        self.assertEqual(doc["voices"]["nova"], [0, 1])
        self.assertEqual(doc["voices"]["atlas"], [1])

    def test_unreachable_replica_is_named_not_dropped(self) -> None:
        responses = {"a": {"in_flight": 1, "available_permits": 1,
                           "live_workers": 1, "queue_depth": 0},
                     "b": ConnectionError("refused")}
        doc = rep.aggregate_introspection([(0, "a"), (1, "b")],
                                          fetch=self._fetch(responses))
        self.assertEqual(doc["replicas_reporting"], 1)
        self.assertFalse(doc["complete"])
        self.assertFalse(doc["replicas"][1]["ok"])
        self.assertIn("refused", doc["replicas"][1]["error"])
        self.assertEqual(doc["totals"]["in_flight"], 1)

    def test_drained_replicas_are_flagged(self) -> None:
        doc = rep.aggregate_introspection(
            [(0, "a")], fetch=lambda u: {"in_flight": 0}, drained=(0,))
        self.assertTrue(doc["replicas"][0]["drained"])
        self.assertEqual(doc["drained"], [0])


# ---------------------------------------------------------------------------
# Fabric: routing decisions
# ---------------------------------------------------------------------------
def _snap(i, permits=1, depth=0, in_flight=0, voices=None, ok=True):
    s = {"replica": i, "ok": ok, "available_permits": permits,
         "queue_depth": depth, "in_flight": in_flight}
    if voices is not None:
        s["voice_lru_keys"] = list(voices)
    return s


class ChooseReplicaTests(unittest.TestCase):
    def test_free_permits_outrank_voice_affinity(self) -> None:
        # A hot voice on a replica that will queue the request is not a win.
        snaps = [_snap(0, permits=0, voices=["nova"]), _snap(1, permits=2)]
        self.assertEqual(rep.choose_replica(snaps, voice_id="nova"), 1)

    def test_voice_affinity_breaks_a_capacity_tie(self) -> None:
        snaps = [_snap(0, permits=2), _snap(1, permits=2, voices=["nova"])]
        self.assertEqual(rep.choose_replica(snaps, voice_id="nova"), 1)
        self.assertEqual(rep.choose_replica(snaps), 0)   # no voice -> index tie

    def test_most_free_permits_then_shortest_queue(self) -> None:
        snaps = [_snap(0, permits=1, depth=0), _snap(1, permits=3, depth=9)]
        self.assertEqual(rep.choose_replica(snaps), 1)
        snaps = [_snap(0, permits=2, depth=4), _snap(1, permits=2, depth=1)]
        self.assertEqual(rep.choose_replica(snaps), 1)

    def test_saturated_pool_still_picks_the_shortest_queue(self) -> None:
        snaps = [_snap(0, permits=0, depth=5), _snap(1, permits=0, depth=2)]
        self.assertEqual(rep.choose_replica(snaps), 1)

    def test_drained_unreachable_and_draining_are_never_chosen(self) -> None:
        snaps = [_snap(0, permits=9), _snap(1, permits=9)]
        self.assertEqual(rep.choose_replica(snaps, drained=(0,)), 1)
        self.assertIsNone(rep.choose_replica([_snap(0, ok=False)]))
        draining = _snap(0, permits=9)
        draining["draining"] = True
        self.assertIsNone(rep.choose_replica([draining]))

    def test_missing_fields_do_not_crash_the_pick(self) -> None:
        self.assertEqual(rep.choose_replica([{"replica": 0, "ok": True}]), 0)


class VoiceOfRequestTests(unittest.TestCase):
    def test_reads_the_voice_from_a_json_body(self) -> None:
        body = b'{"voice_id": "nova", "text": "hi"}'
        self.assertEqual(rep.voice_of_request(body, "application/json"), "nova")

    def test_unparseable_or_non_json_costs_only_the_affinity_term(self) -> None:
        self.assertIsNone(rep.voice_of_request(b"not json", "application/json"))
        self.assertIsNone(rep.voice_of_request(b'{"voice_id":"n"}', "audio/wav"))
        self.assertIsNone(rep.voice_of_request(b"", "application/json"))
        self.assertIsNone(rep.voice_of_request(b'["a"]', "application/json"))


class RouterStateTests(unittest.TestCase):
    def _router(self, responses, clock=None):
        clock = clock or _Clock()
        return rep.Router(backends=["http://127.0.0.1:8000",
                                    "http://127.0.0.1:8001"],
                          introspect=[(0, "a"), (1, "b")],
                          fetch=lambda u: responses[u], clock=clock), clock

    def test_picks_the_cheapest_replica(self) -> None:
        router, _ = self._router({"a": {"available_permits": 0, "queue_depth": 3},
                                  "b": {"available_permits": 2, "queue_depth": 0}})
        self.assertEqual(router.pick(), 1)

    def test_snapshots_are_cached_so_routing_is_not_n_round_trips(self) -> None:
        calls = []

        def fetch(url):
            calls.append(url)
            return {"available_permits": 1}

        router = rep.Router(["u0", "u1"], [(0, "a"), (1, "b")], fetch=fetch,
                            ttl_s=10.0, clock=_Clock())
        router.pick()
        router.pick()
        self.assertEqual(len(calls), 2)      # one sweep, not two
        router.snapshots(force=True)
        self.assertEqual(len(calls), 4)

    def test_cache_expires(self) -> None:
        clock = _Clock()
        calls = []

        def fetch(url):
            calls.append(url)
            return {"available_permits": 1}

        router = rep.Router(["u0"], [(0, "a")], fetch=fetch, ttl_s=0.5,
                            clock=clock)
        router.pick()
        clock.t = 1.0
        router.pick()
        self.assertEqual(len(calls), 2)

    def test_drained_replica_stops_receiving_routes(self) -> None:
        router, _ = self._router({"a": {"available_permits": 5},
                                  "b": {"available_permits": 1}})
        self.assertEqual(router.pick(), 0)
        router.mark_drained(0)
        self.assertEqual(router.drained, (0,))
        self.assertEqual(router.pick(), 1)
        router.unmark_drained(0)
        self.assertEqual(router.drained, ())


# ---------------------------------------------------------------------------
# Fabric: drain-based replacement
# ---------------------------------------------------------------------------
class DrainTests(unittest.TestCase):
    def _make(self, **kw):
        spawn = _FakeSpawn(graceful=True)
        clock = _Clock()
        sup = rep.ReplicaSupervisor(
            replicas=2, port=8000, host="127.0.0.1", reuse_port=False, cores=8,
            spawn=spawn, clock=clock,
            sleep=lambda s: setattr(clock, "t", clock.t + s), **kw)
        sup.start()
        return sup, spawn, clock

    def test_waits_for_in_flight_to_reach_zero(self) -> None:
        sup, _, _ = self._make()
        seen = [{"in_flight": 2}, {"in_flight": 1}, {"in_flight": 0}]
        router = rep.Router(["u0", "u1"], [(0, "a"), (1, "b")],
                            fetch=lambda u: {"available_permits": 1},
                            clock=_Clock())
        res = sup.drain_replica(0, router=router, fetch=lambda u: seen.pop(0))
        self.assertTrue(res["drained"])
        self.assertFalse(res["degraded"])
        self.assertEqual(res["in_flight"], 0)
        self.assertTrue(sup.replicas[0].draining)
        self.assertEqual(router.drained, (0,))

    def test_router_off_degrades_by_name_instead_of_pretending(self) -> None:
        sup, _, _ = self._make()
        res = sup.drain_replica(0, router=None, fetch=lambda u: {"in_flight": 0})
        self.assertTrue(res["drained"])          # in-flight work did finish...
        self.assertTrue(res["degraded"])         # ...but nothing stopped new work
        self.assertIn("router disabled", res["reasons"][0])

    def test_timeout_is_reported_not_swallowed(self) -> None:
        sup, _, clock = self._make()
        res = sup.drain_replica(0, timeout_s=2.0, poll_s=1.0,
                                fetch=lambda u: {"in_flight": 4})
        self.assertFalse(res["drained"])
        self.assertTrue(res["degraded"])
        self.assertTrue(any("timed out" in r for r in res["reasons"]))
        self.assertEqual(res["in_flight"], 4)

    def test_without_admin_ports_the_drain_admits_it_cannot_observe(self) -> None:
        sup, _, _ = self._make(admin=False)
        res = sup.drain_replica(0)
        self.assertFalse(res["drained"])
        self.assertTrue(res["degraded"])
        self.assertTrue(any("no admin port" in r for r in res["reasons"]))

    def test_unreachable_introspect_is_not_a_claimed_quiesce(self) -> None:
        sup, _, _ = self._make()

        def fetch(url):
            raise ConnectionError("refused")

        res = sup.drain_replica(0, fetch=fetch)
        self.assertFalse(res["drained"])
        self.assertTrue(any("unreachable" in r for r in res["reasons"]))

    def test_drain_and_replace_spawns_a_successor_and_resumes_routing(self) -> None:
        sup, spawn, _ = self._make()
        router = rep.Router(["u0", "u1"], [(0, "a"), (1, "b")],
                            fetch=lambda u: {"available_permits": 1},
                            clock=_Clock())
        old = sup.replicas[0].proc
        res = sup.drain_and_replace(0, router=router,
                                    fetch=lambda u: {"in_flight": 0})
        self.assertTrue(res["replaced"])
        self.assertEqual(len(spawn.calls), 3)          # 2 at start + 1 successor
        self.assertIsNot(sup.replicas[0].proc, old)
        self.assertEqual(old.terminated, 1)
        self.assertFalse(sup.replicas[0].draining)
        self.assertEqual(router.drained, ())

    def test_replacement_does_not_feed_the_crash_backoff(self) -> None:
        sup, _, _ = self._make()
        sup.replicas[0].consecutive_failures = 3
        sup.replace_replica(0)
        self.assertEqual(sup.replicas[0].consecutive_failures, 0)


# ---------------------------------------------------------------------------
# Fabric: live HTTP surfaces (real sockets, no model anywhere)
# ---------------------------------------------------------------------------
class _Serving:
    """Run a stdlib HTTP server on an ephemeral port for the duration of a test."""

    def __init__(self, server) -> None:
        self.server = server
        self.port = server.server_address[1]
        self._t = threading.Thread(target=server.serve_forever, daemon=True)
        self._t.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self._t.join(timeout=5)


class AdminServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = _FakeEngine(permits=2, live=1, queued=1, in_flight=1,
                                  voices=["nova"])
        self.admin = _Serving(rep.make_admin_server(
            0, lambda: self.engine, index=0, cache_getter=lambda: {"hits": 3}))
        self.addCleanup(self.admin.close)

    def test_binds_loopback_only(self) -> None:
        # Capacity detail must never ride the launcher's --host (often 0.0.0.0).
        self.assertEqual(self.admin.server.server_address[0], rep.ADMIN_HOST)

    def test_introspect_and_metrics_are_served(self) -> None:
        base = f"http://127.0.0.1:{self.admin.port}"
        doc = rep._http_get_json(base + "/introspect")
        self.assertEqual(doc["available_permits"], 2)
        self.assertEqual(doc["voice_lru_keys"], ["nova"])
        met = rep._http_get_json(base + "/metrics")
        self.assertIn("config", met)
        self.assertEqual(met["cache"], {"hits": 3})
        self.assertEqual(met["metrics"]["in_flight"], 1)

    def test_aggregator_can_scrape_the_admin_metrics_as_a_pool_total(self) -> None:
        targets = [(0, f"http://127.0.0.1:{self.admin.port}/metrics")]
        doc = rep.aggregate_metrics(targets, scope=rep.SCOPE_POOL_TOTAL)
        self.assertEqual(doc["scope"], rep.SCOPE_POOL_TOTAL)
        self.assertEqual(doc["totals"]["in_flight"], 1)
        self.assertTrue(doc["complete"])

    def test_unknown_path_is_404_not_a_silent_metrics_answer(self) -> None:
        import urllib.error
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            rep._http_get_json(f"http://127.0.0.1:{self.admin.port}/secrets")
        self.assertEqual(ctx.exception.code, 404)


class PoolViewTests(unittest.TestCase):
    def test_pool_folds_metrics_and_introspection_into_one_document(self) -> None:
        engine = _FakeEngine(permits=2, live=1, queued=4, in_flight=1,
                             voices=["nova"])
        admin = _Serving(rep.make_admin_server(0, lambda: engine, index=0))
        self.addCleanup(admin.close)
        base = f"http://127.0.0.1:{admin.port}"
        front = _Serving(rep.make_metrics_server(
            "127.0.0.1", 0, [(0, base + "/metrics")],
            scope=rep.SCOPE_POOL_TOTAL, replicas_expected=1,
            introspect=[(0, base + "/introspect")]))
        self.addCleanup(front.close)

        pool = rep._http_get_json(f"http://127.0.0.1:{front.port}/pool")
        self.assertEqual(pool["routing"], "direct")
        self.assertEqual(pool["totals"]["queue_depth"], 4)
        self.assertEqual(pool["voices"]["nova"], [0])
        self.assertEqual(pool["metrics"]["scope"], rep.SCOPE_POOL_TOTAL)
        self.assertEqual(pool["metrics"]["totals"]["in_flight"], 1)

        intro = rep._http_get_json(f"http://127.0.0.1:{front.port}/introspect")
        self.assertEqual(intro["replicas_reporting"], 1)


class ForwardedForTests(unittest.TestCase):
    """The router is a hop, and a hop that hides the caller collapses every
    per-IP budget downstream into one bucket."""

    def test_the_peer_is_appended_to_an_existing_chain(self) -> None:
        self.assertEqual(rep.forwarded_for("203.0.113.7", "10.0.0.2"),
                         "203.0.113.7, 10.0.0.2")

    def test_a_first_hop_starts_the_chain(self) -> None:
        self.assertEqual(rep.forwarded_for("", "203.0.113.7"), "203.0.113.7")

    def test_an_unknown_peer_passes_the_chain_through_unchanged(self) -> None:
        self.assertEqual(rep.forwarded_for("203.0.113.7", ""), "203.0.113.7")

    def test_a_forged_chain_cannot_grow_without_bound(self) -> None:
        chain = rep.forwarded_for(", ".join(f"1.1.1.{i}" for i in range(200)),
                                  "10.0.0.2")
        parts = chain.split(", ")
        self.assertLessEqual(len(parts), rep._MAX_FORWARDED_ENTRIES)
        # Ours is still the last entry, which is the one a hop-counting reader
        # trusts — truncation takes from the FORGED end.
        self.assertEqual(parts[-1], "10.0.0.2")


class PublicBindIntrospectionTests(unittest.TestCase):
    """Capacity detail is not a public metric.

    ``make_admin_server`` refuses a host on principle; ``make_metrics_server``
    binds ``--host`` (routinely 0.0.0.0) and was serving per-replica permits,
    queue depth, the voice->replica map and the drained set to anyone who could
    reach the port. On a public bind that is now refused by name.
    """

    def _front(self, host: str):
        engine = _FakeEngine(permits=2, live=1, queued=4, in_flight=1,
                             voices=["nova"])
        admin = _Serving(rep.make_admin_server(0, lambda: engine, index=0))
        self.addCleanup(admin.close)
        base = f"http://127.0.0.1:{admin.port}"
        front = _Serving(rep.make_metrics_server(
            host, 0, [(0, base + "/metrics")], scope=rep.SCOPE_POOL_TOTAL,
            replicas_expected=1, introspect=[(0, base + "/introspect")]))
        self.addCleanup(front.close)
        return front

    def test_loopback_serves_everything_as_before(self) -> None:
        front = self._front("127.0.0.1")
        pool = rep._http_get_json(f"http://127.0.0.1:{front.port}/pool")
        self.assertEqual(pool["voices"]["nova"], [0])
        self.assertFalse(pool["restricted"])
        intro = rep._http_get_json(f"http://127.0.0.1:{front.port}/introspect")
        self.assertEqual(intro["replicas_reporting"], 1)

    def test_a_public_bind_refuses_introspect_by_name(self) -> None:
        front = self._front("0.0.0.0")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            rep._http_get_json(f"http://127.0.0.1:{front.port}/introspect")
        self.assertEqual(ctx.exception.code, 403)
        detail = json.loads(ctx.exception.read().decode("utf-8"))["detail"]
        self.assertIn("loopback-only", detail)
        self.assertIn(rep.PUBLIC_INTROSPECT_ENV, detail)

    def test_a_public_pool_view_keeps_only_what_metrics_already_says(self) -> None:
        front = self._front("0.0.0.0")
        pool = rep._http_get_json(f"http://127.0.0.1:{front.port}/pool")
        self.assertTrue(pool["restricted"])
        self.assertEqual(pool["metrics"]["totals"]["in_flight"], 1)
        for leaked in ("voices", "replicas", "totals", "drained"):
            self.assertNotIn(leaked, pool, f"{leaked} is capacity detail")

    def test_metrics_itself_is_unchanged_on_a_public_bind(self) -> None:
        front = self._front("0.0.0.0")
        doc = rep._http_get_json(f"http://127.0.0.1:{front.port}/metrics")
        self.assertEqual(doc["scope"], rep.SCOPE_POOL_TOTAL)
        self.assertEqual(doc["totals"]["in_flight"], 1)

    def test_an_operator_can_opt_back_in_explicitly(self) -> None:
        import os
        os.environ[rep.PUBLIC_INTROSPECT_ENV] = "1"
        self.addCleanup(os.environ.pop, rep.PUBLIC_INTROSPECT_ENV, None)
        front = self._front("0.0.0.0")
        intro = rep._http_get_json(f"http://127.0.0.1:{front.port}/introspect")
        self.assertEqual(intro["replicas_reporting"], 1)

    def test_which_hosts_count_as_loopback(self) -> None:
        for host in ("127.0.0.1", "127.0.0.53", "localhost", "::1"):
            self.assertTrue(rep.is_loopback_host(host), host)
        for host in ("0.0.0.0", "", "10.0.0.4", "example.com"):
            self.assertFalse(rep.is_loopback_host(host), host)


class RouterProxyTests(unittest.TestCase):
    """The router is a real HTTP hop: prove a request survives it."""

    def _backend(self, tag: str):
        import http.server

        class _Echo(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("Content-Length") or 0)
                body = json.dumps({
                    "backend": tag, "path": self.path,
                    "echo": self.rfile.read(n).decode("utf-8"),
                }).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        return _Serving(ThreadingHTTPServer(("127.0.0.1", 0), _Echo))

    def test_request_lands_on_the_replica_with_the_hot_voice(self) -> None:
        cold, hot = self._backend("cold"), self._backend("hot")
        self.addCleanup(cold.close)
        self.addCleanup(hot.close)
        snaps = {
            "a": {"available_permits": 2, "queue_depth": 0, "in_flight": 0},
            "b": {"available_permits": 2, "queue_depth": 0,
                  "voice_lru_keys": ["nova"], "in_flight": 0},
        }
        router = rep.Router(
            [f"http://127.0.0.1:{cold.port}", f"http://127.0.0.1:{hot.port}"],
            [(0, "a"), (1, "b")], fetch=lambda u: snaps[u], ttl_s=0.0)
        front = _Serving(rep.make_metrics_server(
            "127.0.0.1", 0, [], scope=rep.SCOPE_POOL_TOTAL,
            introspect=[(0, "a"), (1, "b")], router=router))
        self.addCleanup(front.close)

        payload = json.dumps({"voice_id": "nova", "text": "hello"}).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{front.port}/v1/tts", data=payload,
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            self.assertEqual(resp.headers["X-Gravitone-Replica"], "1")
            body = json.loads(resp.read().decode("utf-8"))
        self.assertEqual(body["backend"], "hot")
        self.assertEqual(body["path"], "/v1/tts")
        self.assertEqual(json.loads(body["echo"])["text"], "hello")

    def test_the_caller_s_address_reaches_the_replica(self) -> None:
        import http.server

        seen: list[str] = []

        class _Echo(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):  # noqa: N802
                seen.append(self.headers.get("X-Forwarded-For", ""))
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *a):
                pass

        backend = _Serving(ThreadingHTTPServer(("127.0.0.1", 0), _Echo))
        self.addCleanup(backend.close)
        router = rep.Router([f"http://127.0.0.1:{backend.port}"], [(0, "a")],
                            fetch=lambda u: {"available_permits": 1}, ttl_s=0.0)
        front = _Serving(rep.make_metrics_server(
            "127.0.0.1", 0, [], scope=rep.SCOPE_POOL_TOTAL,
            introspect=[(0, "a")], router=router))
        self.addCleanup(front.close)

        req = urllib.request.Request(
            f"http://127.0.0.1:{front.port}/v1/tts", data=b"{}",
            headers={"Content-Type": "application/json",
                     "X-Forwarded-For": "203.0.113.7"}, method="POST")
        with urllib.request.urlopen(req, timeout=10):
            pass
        # Appended, not replaced: the CDN's entry survives and ours is last.
        self.assertEqual(len(seen), 1)
        self.assertTrue(seen[0].startswith("203.0.113.7, "), seen)
        self.assertTrue(seen[0].endswith("127.0.0.1"), seen)

    def test_no_available_replica_is_a_503_not_a_hang(self) -> None:
        router = rep.Router([], [], fetch=lambda u: {}, ttl_s=0.0)
        front = _Serving(rep.make_metrics_server(
            "127.0.0.1", 0, [], scope=rep.SCOPE_POOL_TOTAL, introspect=[],
            router=router))
        self.addCleanup(front.close)
        req = urllib.request.Request(f"http://127.0.0.1:{front.port}/v1/tts",
                                     data=b"{}", method="POST")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(ctx.exception.code, 503)

    def test_metrics_route_still_wins_over_the_proxy(self) -> None:
        router = rep.Router([], [], fetch=lambda u: {}, ttl_s=0.0)
        front = _Serving(rep.make_metrics_server(
            "127.0.0.1", 0, [], scope=rep.SCOPE_POOL_TOTAL, introspect=[],
            router=router))
        self.addCleanup(front.close)
        doc = rep._http_get_json(f"http://127.0.0.1:{front.port}/metrics")
        self.assertEqual(doc["scope"], rep.SCOPE_POOL_TOTAL)


# ---------------------------------------------------------------------------
# The stdlib-only law
# ---------------------------------------------------------------------------
class StdlibOnlyImportTests(unittest.TestCase):
    """The supervisor process must never import the service (and thus torch).

    Child mode DOES touch uvicorn and service.app — but only inside functions
    that run in the replica process. This test pins the module's TOP-LEVEL
    imports, which is the line that actually matters.
    """

    ALLOWED = {
        "__future__", "argparse", "json", "logging", "os", "signal", "socket",
        "subprocess", "sys", "threading", "time", "urllib", "dataclasses",
        "http", "typing",
    }

    def test_module_level_imports_are_stdlib_only(self) -> None:
        import ast
        import inspect

        tree = ast.parse(inspect.getsource(rep))
        roots = set()
        for node in tree.body:      # TOP LEVEL only, deliberately
            if isinstance(node, ast.Import):
                roots.update(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                roots.add((node.module or "").split(".")[0])
        self.assertEqual(
            roots - self.ALLOWED, set(),
            "service/replicas.py grew a module-level import outside the stdlib "
            "allowlist. The supervisor imports this module in a process that "
            "must not load torch/scipy; child-side imports belong inside the "
            "function that runs in the replica.")
        self.assertNotIn("service", roots)


if __name__ == "__main__":
    unittest.main()
