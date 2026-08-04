"""The per-IP budget across PROCESSES, which is how the service ships.

`ratelimit.RateLimiter` counts in memory. The service runs as N single-worker
processes (`service/replicas.py`), so in-memory counting means the pool spends
N budgets and the 429 body quotes a number nobody enforced. These cases prove
the shared window actually counts across processes — with REAL child processes,
because a threading test would pass just as happily against the bug.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from service import ratelimit
from service.ratelimit import RateLimiter, SharedWindow

REPO_ROOT = Path(__file__).resolve().parents[2]

# One child = one replica: build the same budget, spend it until refused, and
# report how many it actually got. Deliberately a fresh interpreter, not a
# fork, so nothing in-memory can be shared by accident.
_CHILD = """
import json, sys
sys.path.insert(0, %(root)r)
from service.ratelimit import RateLimiter, SharedWindow

directory = %(dir)r
window = SharedWindow("pool", limit=%(limit)d, window_s=600,
                      dir_getter=lambda: __import__("pathlib").Path(directory))
rl = RateLimiter(limit=%(limit)d, window_s=600, burst=%(limit)d,
                 shared=window, replicas=%(replicas)d)
allowed = 0
for _ in range(%(attempts)d):
    if rl.check("1.2.3.4").allowed:
        allowed += 1
print(json.dumps({"allowed": allowed, "claims": window.claims,
                  "degraded": window.degraded}))
"""


def _run_children(directory: str, n: int, limit: int, attempts: int) -> list[dict]:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(REPO_ROOT)
    procs = [
        subprocess.Popen(
            [sys.executable, "-c", _CHILD % {"root": str(REPO_ROOT),
                                             "dir": directory, "limit": limit,
                                             "replicas": n,
                                             "attempts": attempts}],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
            cwd=str(REPO_ROOT), text=True)
        for _ in range(n)
    ]
    out = []
    for p in procs:
        stdout, stderr = p.communicate(timeout=120)
        if p.returncode != 0:
            raise AssertionError(f"child failed: {stderr}")
        out.append(json.loads(stdout.strip().splitlines()[-1]))
    return out


class SharedWindowAcrossProcessesTests(unittest.TestCase):
    def test_four_processes_share_one_budget_instead_of_taking_four(self) -> None:
        with TemporaryDirectory() as td:
            results = _run_children(td, n=4, limit=40, attempts=40)
            total = sum(r["allowed"] for r in results)
            # The bug this closes: 4 x 40 = 160 allowed against a stated 40.
            self.assertLessEqual(total, 40, results)
            # And the lease must not throw the budget away either: the pool
            # loses at most (lease-1) per process to unspent leases.
            lease = RateLimiter(40, 600, 40, replicas=4).lease
            self.assertGreaterEqual(total, 40 - 4 * (lease - 1), results)

    def test_the_file_is_touched_once_per_lease_not_once_per_request(self) -> None:
        # The hot path's whole justification. With limit 40 over 4 replicas the
        # lease is 2, so ~20 claims would be the per-request cost of 40.
        with TemporaryDirectory() as td:
            results = _run_children(td, n=4, limit=40, attempts=40)
            claims = sum(r["claims"] for r in results)
            allowed = sum(r["allowed"] for r in results)
            self.assertLessEqual(claims, allowed // 2 + 4,
                                 "a claim per allowed request defeats the lease")
            self.assertEqual(sum(r["degraded"] for r in results), 0)

    def test_a_second_process_sees_the_first_one_s_spend(self) -> None:
        with TemporaryDirectory() as td:
            first = _run_children(td, n=1, limit=6, attempts=6)
            self.assertEqual(first[0]["allowed"], 6)
            second = _run_children(td, n=1, limit=6, attempts=6)
            self.assertEqual(second[0]["allowed"], 0,
                             "the budget was already spent by another process")


class SharedWindowUnitTests(unittest.TestCase):
    def _window(self, td: str, **kw) -> SharedWindow:
        return SharedWindow("b", dir_getter=lambda: Path(td),
                            **{"limit": 10, "window_s": 60, **kw})

    def test_claims_are_capped_at_the_pool_limit(self) -> None:
        with TemporaryDirectory() as td:
            w = self._window(td, limit=5)
            self.assertEqual(w.claim("ip", 100.0, 4)[1], 4)
            self.assertEqual(w.claim("ip", 100.0, 4)[1], 1)
            self.assertEqual(w.claim("ip", 100.0, 4)[1], 0)

    def test_the_window_rolls_and_the_start_is_shared(self) -> None:
        with TemporaryDirectory() as td:
            w = self._window(td, limit=2, window_s=60)
            start, granted = w.claim("ip", 100.0, 2)
            self.assertEqual((start, granted), (100.0, 2))
            self.assertEqual(w.claim("ip", 130.0, 2)[1], 0)   # same window
            start2, granted2 = w.claim("ip", 161.0, 2)        # rolled
            self.assertEqual((start2, granted2), (161.0, 2))

    def test_callers_do_not_share_a_bucket(self) -> None:
        with TemporaryDirectory() as td:
            w = self._window(td, limit=1)
            self.assertEqual(w.claim("a", 1.0, 1)[1], 1)
            self.assertEqual(w.claim("b", 1.0, 1)[1], 1)

    def test_the_file_is_bounded_like_the_in_memory_limiter(self) -> None:
        with TemporaryDirectory() as td:
            w = self._window(td, limit=1, max_keys=4)
            for i in range(50):
                w.claim(f"ip-{i}", 1.0, 1)
            data = json.loads(w.path.read_text("utf-8"))
            self.assertEqual(len(data), 4)
            self.assertIn("ip-49", data)

    def test_an_unwritable_store_degrades_loudly_instead_of_refusing(self) -> None:
        # A limiter that fails the service because a JSON file is unwritable is
        # a worse outage than the one it prevents.
        def _broken():
            raise OSError("read-only file system")

        w = SharedWindow("b", limit=3, window_s=60, dir_getter=_broken)
        start, granted = w.claim("ip", 5.0, 2)
        self.assertEqual((start, granted), (5.0, 2))
        self.assertEqual(w.degraded, 1)

    def test_a_corrupt_store_starts_a_fresh_window_rather_than_wedging(self) -> None:
        with TemporaryDirectory() as td:
            w = self._window(td, limit=3)
            w.path.parent.mkdir(parents=True, exist_ok=True)
            w.path.write_text("{not json", "utf-8")
            self.assertEqual(w.claim("ip", 1.0, 3)[1], 3)


class LimiterHonestyTests(unittest.TestCase):
    """What the 429 says must be what the deployment does."""

    def test_unshared_multi_replica_states_the_pool_wide_truth(self) -> None:
        rl = RateLimiter(limit=60, window_s=60, burst=6, replicas=4)
        self.assertEqual(rl.effective_limit, 240)
        self.assertIn("PER REPLICA", rl.describe())
        self.assertIn("240", rl.describe())

    def test_shared_states_that_the_budget_is_pool_wide(self) -> None:
        with TemporaryDirectory() as td:
            w = SharedWindow("b", 60, 60, dir_getter=lambda: Path(td))
            rl = RateLimiter(limit=60, window_s=60, burst=6, shared=w,
                             replicas=4)
            self.assertEqual(rl.effective_limit, 60)
            self.assertIn("across all 4", rl.describe())

    def test_a_single_process_says_what_it_always_said(self) -> None:
        rl = RateLimiter(limit=60, window_s=60, burst=6, replicas=1)
        self.assertEqual(rl.describe(),
                         "60 request(s) per 60s from one address (burst 6 per 1s)")

    def test_an_exhausted_pool_stops_touching_the_disk(self) -> None:
        # The flood path: once the pool has said no, refusals are answered from
        # memory until the window rolls.
        with TemporaryDirectory() as td:
            w = SharedWindow("b", 2, 60, dir_getter=lambda: Path(td))
            rl = RateLimiter(limit=2, window_s=60, burst=2, shared=w,
                             replicas=2, clock=lambda: 500.0)
            for _ in range(2):
                self.assertTrue(rl.check("ip").allowed)
            claims_before = w.claims
            for _ in range(200):
                self.assertFalse(rl.check("ip").allowed)
            self.assertLessEqual(w.claims - claims_before, 1)

    def test_reset_clears_the_shared_file_too(self) -> None:
        with TemporaryDirectory() as td:
            w = SharedWindow("b", 1, 60, dir_getter=lambda: Path(td))
            rl = RateLimiter(limit=1, window_s=60, burst=1, shared=w,
                             replicas=2, clock=lambda: 1.0)
            self.assertTrue(rl.check("ip").allowed)
            self.assertFalse(rl.check("ip").allowed)
            rl.reset()
            self.assertTrue(rl.check("ip").allowed)


class SharedModeSelectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = {k: os.environ.get(k)
                       for k in ("TTS_REPLICAS", "TTS_RATELIMIT_SHARED")}

    def tearDown(self) -> None:
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_one_process_never_touches_the_disk(self) -> None:
        os.environ.pop("TTS_REPLICAS", None)
        os.environ.pop("TTS_RATELIMIT_SHARED", None)
        self.assertEqual(ratelimit.replica_count(), 1)
        self.assertFalse(ratelimit.shared_enabled())

    def test_the_launcher_s_replica_count_turns_sharing_on(self) -> None:
        os.environ["TTS_REPLICAS"] = "4"
        os.environ.pop("TTS_RATELIMIT_SHARED", None)
        self.assertTrue(ratelimit.shared_enabled())

    def test_an_operator_can_force_it_either_way(self) -> None:
        os.environ["TTS_REPLICAS"] = "4"
        os.environ["TTS_RATELIMIT_SHARED"] = "0"
        self.assertFalse(ratelimit.shared_enabled())
        os.environ["TTS_REPLICAS"] = "1"
        os.environ["TTS_RATELIMIT_SHARED"] = "1"
        self.assertTrue(ratelimit.shared_enabled())

    def test_a_nonsense_replica_count_reads_as_one(self) -> None:
        os.environ["TTS_REPLICAS"] = "lots"
        self.assertEqual(ratelimit.replica_count(), 1)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
