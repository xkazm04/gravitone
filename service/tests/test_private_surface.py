"""The service's own private surface: /health, /metrics, docs, and the 429 path.

Nothing used to test either endpoint's HTTP response, and both published
`ENGINE.config()` — worker counts, torch thread budgets, quantization, the whole
Arm tuning dict — plus full latency percentiles, unauthenticated, alongside
FastAPI's default /docs + /openapi.json catalogue of every route including
/v1/keys.

What must NOT change (traced consumers, all unauthenticated):
  * k8s readinessProbe (deploy/helm/.../deployment.yaml), deploy/bootstrap.sh,
    deploy/aws-oneclick.sh, benchmark_arm*.sh, benchmark_t4g.sh — status code
    and the "draining" body.
  * service/loadtest.py — polls /health for readiness.
  * web/lib/useHealthPoll.ts via web/app/api/health/route.ts — the studio's
    proxy DOES attach the root key (web/lib/backend.ts), so it keeps seeing
    config/metrics; its `Health` type already had both fields optional.
  * service/replicas.py — the supervisor aggregates each replica's /metrics
    with a credential-less stdlib urlopen over loopback.

Enforcement is re-enabled here the same way test_auth.py does it: rebind
`service.auth.SETTINGS` (the package pins TTS_API_KEY="" for every other test).
"""
from __future__ import annotations

import dataclasses
import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
import service.auth as auth
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = "root-key-for-tests"


class _EngineCase(unittest.TestCase):
    """A ready fake engine wired into the app, with auth toggled per test."""

    KEYED = True

    def setUp(self) -> None:
        self._settings = auth.SETTINGS
        self._app_settings = appmod.SETTINGS
        self._validate = auth.validate_key
        self._engine = appmod.ENGINE
        if self.KEYED:
            auth.SETTINGS = dataclasses.replace(auth.SETTINGS, api_key=ROOT)
        auth.validate_key = lambda secret, scope: False
        self.engine = fake_engine.FakeEngine(workers=1, delay=0.01)
        # `ready`/`draining` are the real engine's readiness flags; the fake
        # doesn't model worker threads, so set them explicitly (as test_drain
        # does) to land on the ready branch.
        self.engine.ready = True
        self.engine.draining = False
        appmod.ENGINE = self.engine
        self.client = TestClient(appmod.app, raise_server_exceptions=False)

    def tearDown(self) -> None:
        auth.SETTINGS = self._settings
        appmod.SETTINGS = self._app_settings
        auth.validate_key = self._validate
        appmod.ENGINE = self._engine
        self.engine.close()

    def _health(self, headers: dict | None = None):
        # TestClient's peer is "testclient", never loopback — so nothing here
        # rides the supervisor exemption by accident.
        return self.client.get("/health", headers=headers or {})

    def _metrics(self, headers: dict | None = None):
        return self.client.get("/metrics", headers=headers or {})


class HealthLivenessTests(_EngineCase):
    def test_liveness_answers_without_a_key(self) -> None:
        resp = self._health()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "ready")

    def test_config_is_not_leaked_unauthenticated(self) -> None:
        body = self._health().json()
        self.assertNotIn("config", body)
        self.assertNotIn("metrics", body)

    def test_key_holder_still_sees_config_and_metrics(self) -> None:
        body = self._health({"xi-api-key": ROOT}).json()
        self.assertIn("config", body)
        self.assertIn("metrics", body)

    def test_managed_key_with_tts_scope_sees_detail(self) -> None:
        # A monitoring key can be issued without granting key management.
        auth.validate_key = lambda secret, scope: secret == "mon" and scope == "tts"
        self.assertIn("config", self._health({"xi-api-key": "mon"}).json())

    def test_draining_shape_is_unchanged_for_probes(self) -> None:
        self.engine.draining = True
        try:
            resp = self._health()
        finally:
            self.engine.draining = False
        self.assertEqual(resp.status_code, 503)
        self.assertEqual(resp.json(), {"status": "draining"})


class HealthOpenModeTests(_EngineCase):
    """No TTS_API_KEY: local dev must be untouched — full body, no key."""

    KEYED = False

    def test_open_mode_health_keeps_config_and_metrics(self) -> None:
        body = self._health().json()
        self.assertIn("config", body)
        self.assertIn("metrics", body)

    def test_open_mode_metrics_needs_no_key(self) -> None:
        resp = self._metrics()
        self.assertEqual(resp.status_code, 200)
        self.assertIn("config", resp.json())


class MetricsAuthTests(_EngineCase):
    def test_metrics_requires_a_key_when_one_is_configured(self) -> None:
        resp = self._metrics()
        self.assertEqual(resp.status_code, 401)
        self.assertIn("scope", resp.json()["detail"])

    def test_metrics_opens_for_the_root_key(self) -> None:
        resp = self._metrics({"xi-api-key": ROOT})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIn("config", body)
        self.assertIn("metrics", body)
        self.assertIn("cache", body)

    def test_bearer_form_works_too(self) -> None:
        self.assertEqual(
            self._metrics({"Authorization": f"Bearer {ROOT}"}).status_code, 200)

    def test_loopback_exemption_keeps_the_supervisor_aggregator_working(self) -> None:
        # service/replicas.py scrapes each replica over 127.0.0.1 with a
        # credential-less urlopen; that must keep working on a keyed service.
        client = TestClient(appmod.app, client=("127.0.0.1", 51234),
                            raise_server_exceptions=False)
        self.assertEqual(client.get("/metrics").status_code, 200)

    def test_loopback_exemption_can_be_switched_off(self) -> None:
        appmod.SETTINGS = dataclasses.replace(appmod.SETTINGS,
                                              metrics_allow_loopback=False)
        client = TestClient(appmod.app, client=("127.0.0.1", 51234),
                            raise_server_exceptions=False)
        self.assertEqual(client.get("/metrics").status_code, 401)

    def test_remote_peer_never_rides_the_exemption(self) -> None:
        client = TestClient(appmod.app, client=("203.0.113.7", 51234),
                            raise_server_exceptions=False)
        self.assertEqual(client.get("/metrics").status_code, 401)


class DocsGatingTests(unittest.TestCase):
    """`docs_urls` decides whether the interactive catalogue is published."""

    def _urls(self, **overrides) -> dict:
        return appmod.docs_urls(dataclasses.replace(appmod.SETTINGS, **overrides))

    def test_auto_publishes_in_open_mode(self) -> None:
        urls = self._urls(api_key="", docs="auto")
        self.assertEqual(urls["openapi_url"], "/openapi.json")

    def test_auto_closes_as_soon_as_a_key_is_set(self) -> None:
        for key in ("auto", "AUTO", " auto "):
            with self.subTest(mode=key):
                urls = self._urls(api_key=ROOT, docs=key)
                self.assertIsNone(urls["docs_url"])
                self.assertIsNone(urls["redoc_url"])
                self.assertIsNone(urls["openapi_url"])

    def test_explicit_on_publishes_even_with_a_key(self) -> None:
        self.assertEqual(self._urls(api_key=ROOT, docs="on")["docs_url"], "/docs")

    def test_explicit_off_closes_even_in_open_mode(self) -> None:
        self.assertIsNone(self._urls(api_key="", docs="off")["docs_url"])

    def test_gated_app_serves_404_for_docs_and_schema(self) -> None:
        gated = FastAPI(**self._urls(api_key=ROOT, docs="auto"))
        client = TestClient(gated)
        for path in ("/docs", "/redoc", "/openapi.json"):
            with self.subTest(path=path):
                self.assertEqual(client.get(path).status_code, 404)


class BackpressureCostTests(_EngineCase):
    """The 429 path must not sort the latency windows on a saturated box."""

    KEYED = False

    def test_backpressure_body_uses_the_cheap_counters(self) -> None:
        calls = {"snapshot": 0, "counters": 0}
        metrics = self.engine.metrics
        real_counters = metrics.counters
        real_snapshot = metrics.snapshot

        def counting_counters():
            calls["counters"] += 1
            return real_counters()

        def counting_snapshot():
            calls["snapshot"] += 1
            return real_snapshot()

        metrics.counters = counting_counters
        metrics.snapshot = counting_snapshot
        resp = appmod._backpressure_response(appmod._Backpressure("queue full"))
        self.assertEqual(resp.status_code, 429)
        self.assertEqual(calls["snapshot"], 0,
                         "the 429 path must not compute percentiles")
        self.assertEqual(calls["counters"], 1)

    def test_backpressure_body_is_still_informative(self) -> None:
        resp = appmod._backpressure_response(appmod._Backpressure("queue full"))
        import json
        body = json.loads(bytes(resp.body).decode())
        self.assertEqual(body["detail"], "queue full")
        for key in ("in_flight", "queued"):
            self.assertIn(key, body["queue"])
        self.assertEqual(resp.headers["Retry-After"], "1")


class MetricsCountersContractTests(unittest.TestCase):
    """engine.Metrics.counters must stay the counter half of snapshot."""

    def test_counters_is_a_subset_of_snapshot_with_no_percentiles(self) -> None:
        from service.engine import Metrics
        m = Metrics()
        m.on_received()
        m.on_finish(1.5, 1.0, 3.0)
        m.on_finish(0.5, 0.4, 2.0)
        m.on_finish(2.5, 2.0, 4.0)
        counters, snap = m.counters(), m.snapshot()
        self.assertTrue(set(counters) <= set(snap))
        for key in counters:
            self.assertEqual(counters[key], snap[key])
        self.assertFalse([k for k in counters if k.endswith("_p50_s")])
        # Percentiles still correct after the sort-once refactor.
        self.assertEqual(snap["latency_p50_s"], 1.5)   # sorted, not insertion
        self.assertEqual(snap["latency_p99_s"], 2.5)
        self.assertEqual(snap["window_size"], 3)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
