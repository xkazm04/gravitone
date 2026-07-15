"""Direction 3 — error hardening on the synthesis path.

Verifies (mocked engine): worker exceptions are sanitized to `synthesis
failed (request <id>)` with the raw text logged server-side, and synthesis
timeouts increment the engine `timeouts` metric behind a 504.
"""
from __future__ import annotations

import logging
import types
import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod


class SanitizeErrorTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_engine = appmod.ENGINE
        self._orig_settings = appmod.SETTINGS
        from fastapi.testclient import TestClient
        self.client = TestClient(appmod.app, raise_server_exceptions=False)

    def tearDown(self) -> None:
        appmod.ENGINE = self._orig_engine
        appmod.SETTINGS = self._orig_settings

    def test_worker_exception_is_sanitized_and_logged(self) -> None:
        secret_trace = "SECRET_TRACE_do_not_leak_boom"
        appmod.ENGINE = fake_engine.FakeEngine(workers=2, delay=0.01,
                                               error=secret_trace)
        with self.assertLogs("gravitone", level="ERROR") as logs:
            resp = self.client.post(
                "/v1/text-to-speech/v",
                params={"output_format": "wav_24000"},
                json={"text": "hello"},
            )
        self.assertEqual(resp.status_code, 500)
        detail = resp.json()["detail"]
        # Client sees only "synthesis failed (request <id>)" — never the raw text.
        self.assertTrue(detail.startswith("synthesis failed (request "))
        self.assertNotIn(secret_trace, detail)
        # ...but the full exception was logged server-side.
        self.assertTrue(any(secret_trace in r.getMessage() for r in logs.records))

    def test_timeout_increments_metric_and_returns_504(self) -> None:
        # Timeout shorter than the fake synthesis delay -> 504 + counted.
        appmod.SETTINGS = types.SimpleNamespace(request_timeout_s=0.05)
        eng = fake_engine.FakeEngine(workers=2, delay=0.5)
        appmod.ENGINE = eng
        resp = self.client.post(
            "/v1/text-to-speech/v",
            params={"output_format": "wav_24000"},
            json={"text": "hello"},
        )
        self.assertEqual(resp.status_code, 504)
        self.assertEqual(eng.metrics.timeouts, 1)


if __name__ == "__main__":
    unittest.main()
