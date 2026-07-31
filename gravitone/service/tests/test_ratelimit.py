"""The shared per-IP limiter: window, burst, memory bound, proxy trust.

Every case drives an INJECTED clock. A limiter tested with sleeps is a test
that is slow when it passes and flaky when it does not, and the window here is
measured in minutes — no suite can afford to live through one.
"""
from __future__ import annotations

import os
import unittest

from service.tests import fake_engine  # noqa: F401  (shims, for import parity)

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from service import ratelimit
from service.ratelimit import RateLimiter, client_ip, per_ip_budget


class _Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


class RateLimiterTest(unittest.TestCase):
    def test_window_allows_the_budget_then_refuses_with_retry_after(self) -> None:
        clock = _Clock()
        rl = RateLimiter(limit=3, window_s=60, burst=3, clock=clock)
        for i in range(3):
            d = rl.check("1.2.3.4")
            self.assertTrue(d.allowed, i)
            clock.advance(2)  # spread them so the burst window is not the gate
        denied = rl.check("1.2.3.4")
        self.assertFalse(denied.allowed)
        self.assertEqual(denied.reason, "window")
        # 3 allowed at t+0/2/4, refused at t+6 -> 54s left of the 60s window.
        self.assertEqual(denied.retry_after, 54)
        self.assertEqual(denied.remaining, 0)

    def test_a_fresh_window_restores_the_budget(self) -> None:
        clock = _Clock()
        rl = RateLimiter(limit=2, window_s=60, burst=2, clock=clock)
        rl.check("ip")
        clock.advance(1)
        rl.check("ip")
        self.assertFalse(rl.check("ip").allowed)
        clock.advance(60)
        self.assertTrue(rl.check("ip").allowed)

    def test_refusals_are_not_counted_so_a_retry_loop_cannot_extend_a_ban(self) -> None:
        clock = _Clock()
        rl = RateLimiter(limit=1, window_s=10, burst=1, clock=clock)
        self.assertTrue(rl.check("ip").allowed)
        for _ in range(50):  # a client ignoring Retry-After
            self.assertFalse(rl.check("ip").allowed)
        clock.advance(10)
        self.assertTrue(rl.check("ip").allowed)

    def test_burst_bounds_a_single_breath_inside_a_generous_window(self) -> None:
        clock = _Clock()
        rl = RateLimiter(limit=100, window_s=60, burst=2, clock=clock)
        self.assertTrue(rl.check("ip").allowed)
        self.assertTrue(rl.check("ip").allowed)
        denied = rl.check("ip")
        self.assertFalse(denied.allowed)
        self.assertEqual(denied.reason, "burst")
        self.assertEqual(denied.retry_after, 1)
        self.assertGreater(denied.remaining, 0)  # the WINDOW still has room
        clock.advance(1.0)
        self.assertTrue(rl.check("ip").allowed)

    def test_default_burst_is_a_quarter_of_the_budget_and_never_zero(self) -> None:
        self.assertEqual(RateLimiter(limit=100, window_s=60).burst, 25)
        self.assertEqual(RateLimiter(limit=3, window_s=300).burst, 1)
        # A burst wider than the window budget is meaningless; it is clamped.
        self.assertEqual(RateLimiter(limit=2, window_s=60, burst=99).burst, 2)

    def test_callers_have_independent_budgets(self) -> None:
        clock = _Clock()
        rl = RateLimiter(limit=1, window_s=60, burst=1, clock=clock)
        self.assertTrue(rl.check("a").allowed)
        self.assertFalse(rl.check("a").allowed)
        self.assertTrue(rl.check("b").allowed)

    def test_memory_is_bounded_by_an_lru_of_callers(self) -> None:
        clock = _Clock()
        rl = RateLimiter(limit=1, window_s=600, burst=1, max_keys=4, clock=clock)
        for i in range(50):
            rl.check(f"ip-{i}")
        self.assertEqual(len(rl._keys), 4)
        # The most recent callers are the ones still remembered.
        self.assertIn("ip-49", rl._keys)
        self.assertNotIn("ip-0", rl._keys)

    def test_lru_keeps_the_caller_that_keeps_knocking(self) -> None:
        clock = _Clock()
        rl = RateLimiter(limit=50, window_s=600, burst=50, max_keys=3, clock=clock)
        for i in range(10):
            rl.check("regular")
            rl.check(f"drive-by-{i}")
        self.assertIn("regular", rl._keys)

    def test_a_clock_that_goes_backwards_does_not_wedge_the_window(self) -> None:
        clock = _Clock()
        rl = RateLimiter(limit=1, window_s=60, burst=1, clock=clock)
        self.assertTrue(rl.check("ip").allowed)
        clock.advance(-3600)  # an injected clock misbehaving
        self.assertTrue(rl.check("ip").allowed)


class _FakeClient:
    def __init__(self, host: str) -> None:
        self.host = host


class _FakeRequest:
    def __init__(self, host: str | None, headers: dict | None = None) -> None:
        self.client = _FakeClient(host) if host else None
        self.headers = headers or {}
        self.method = "POST"


class ClientIdentityTest(unittest.TestCase):
    def test_direct_peer_by_default_even_when_a_header_claims_otherwise(self) -> None:
        req = _FakeRequest("10.0.0.9", {"x-forwarded-for": "1.1.1.1"})
        self.assertEqual(client_ip(req), "10.0.0.9")

    def test_forwarded_for_is_honoured_only_behind_proxy_trust(self) -> None:
        req = _FakeRequest("10.0.0.9", {"x-forwarded-for": "1.1.1.1, 10.0.0.1"})
        self.assertEqual(client_ip(req, trust_proxy=True), "1.1.1.1")

    def test_trusted_proxy_with_no_header_falls_back_to_the_peer(self) -> None:
        self.assertEqual(client_ip(_FakeRequest("10.0.0.9"), trust_proxy=True), "10.0.0.9")

    def test_an_unattributable_caller_budgets_as_unknown(self) -> None:
        self.assertEqual(client_ip(_FakeRequest(None)), "unknown")

    def test_the_module_flag_is_what_the_default_reads(self) -> None:
        req = _FakeRequest("10.0.0.9", {"x-forwarded-for": "1.1.1.1"})
        original = ratelimit.TRUST_PROXY
        try:
            ratelimit.TRUST_PROXY = True
            self.assertEqual(client_ip(req), "1.1.1.1")
        finally:
            ratelimit.TRUST_PROXY = original


class BudgetDependencyTest(unittest.TestCase):
    def _app(self, **kw) -> TestClient:
        app = FastAPI()
        self.budget = per_ip_budget("test-budget", limit=2, window_s=60,
                                    burst=2, clock=self.clock, **kw)

        @app.post("/spend", dependencies=[Depends(self.budget)])
        def spend() -> dict:
            return {"ok": True}

        @app.get("/spend", dependencies=[Depends(self.budget)])
        def read() -> dict:
            return {"ok": True}

        return TestClient(app, raise_server_exceptions=False)

    def setUp(self) -> None:
        self.clock = _Clock()
        # The test package disarms app-wired budgets globally (one fake client
        # address would 429 every heavy suite); THIS suite is the one place the
        # dependency itself is under test, so re-arm it here.
        bypass = os.environ.pop("GRAVITONE_RATELIMIT_TEST_BYPASS", None)
        if bypass is not None:
            self.addCleanup(os.environ.__setitem__,
                            "GRAVITONE_RATELIMIT_TEST_BYPASS", bypass)

    def test_the_refusal_is_named_and_carries_retry_after(self) -> None:
        client = self._app()
        self.assertEqual(client.post("/spend").status_code, 200)
        self.assertEqual(client.post("/spend").status_code, 200)
        r = client.post("/spend")
        self.assertEqual(r.status_code, 429)
        self.assertIn("rate-limited", r.json()["detail"])
        self.assertIn("test-budget", r.json()["detail"])
        self.assertEqual(r.headers["Retry-After"], "60")

    def test_methods_narrows_the_budget_to_the_verbs_that_cost(self) -> None:
        client = self._app(methods=("POST",))
        for _ in range(10):
            self.assertEqual(client.get("/spend").status_code, 200)
        self.assertEqual(client.post("/spend").status_code, 200)
        self.assertEqual(client.post("/spend").status_code, 200)
        self.assertEqual(client.post("/spend").status_code, 429)

    def test_reset_all_clears_every_registered_budget(self) -> None:
        client = self._app()
        client.post("/spend")
        client.post("/spend")
        self.assertEqual(client.post("/spend").status_code, 429)
        ratelimit.reset_all()
        self.assertEqual(client.post("/spend").status_code, 200)

    def test_the_limiter_is_reachable_from_the_dependency_and_the_registry(self) -> None:
        self._app()
        self.assertIs(self.budget.limiter, ratelimit.BUDGETS["test-budget"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
