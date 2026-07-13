"""Direction 3 — replica-native launcher.

Exercises the launcher's pure logic and its supervision without ever spawning a
real uvicorn/model process: subprocess is replaced by a fake, the clock is
injected, and the metrics aggregator is fed stubbed replica responses.
"""
from __future__ import annotations

import logging
import unittest

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

    def test_metrics_targets(self) -> None:
        seq = rep.metrics_targets("0.0.0.0", 8000, 2, reuse_port=False)
        self.assertEqual(seq, [(0, "http://127.0.0.1:8000/metrics"),
                               (1, "http://127.0.0.1:8001/metrics")])
        shared = rep.metrics_targets("0.0.0.0", 8000, 2, reuse_port=True)
        self.assertEqual([u for _, u in shared],
                         ["http://127.0.0.1:8000/metrics"] * 2)

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
                                    fetch=lambda u: responses[u])
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
        self.assertTrue(res["replicas"][0]["ok"])
        self.assertFalse(res["replicas"][1]["ok"])
        self.assertIn("error", res["replicas"][1])

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


if __name__ == "__main__":
    unittest.main()
