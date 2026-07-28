"""Direction 3 — error hardening on the synthesis path.

Verifies (mocked engine): worker exceptions are sanitized to `synthesis
failed (request <id>)` with the raw text logged server-side, and synthesis
timeouts increment the engine `timeouts` metric behind a 504.
"""
from __future__ import annotations

import dataclasses
import logging
import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod


class SanitizeErrorTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig_engine = appmod.ENGINE
        self._orig_settings = appmod.SETTINGS
        appmod.SYNTH_CACHE.clear()  # process-wide singleton — isolate cases
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
                "/v1/text-to-speech/alba",
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
        # replace(), not SimpleNamespace: routes read other SETTINGS fields
        # (e.g. voices_dir in the known-voice check) on the way to submit.
        appmod.SETTINGS = dataclasses.replace(appmod.SETTINGS,
                                              request_timeout_s=0.05)
        eng = fake_engine.FakeEngine(workers=2, delay=0.5)
        appmod.ENGINE = eng
        resp = self.client.post(
            "/v1/text-to-speech/alba",
            params={"output_format": "wav_24000"},
            json={"text": "hello"},
        )
        self.assertEqual(resp.status_code, 504)
        self.assertEqual(eng.metrics.timeouts, 1)


class CatchAllContractTests(unittest.TestCase):
    """Unhandled exceptions must keep the {"detail"} JSON contract (sanitized
    request-id body) instead of Starlette's plain-text 'Internal Server Error'.
    """

    def setUp(self) -> None:
        self._orig_engine = appmod.ENGINE
        appmod.SYNTH_CACHE.clear()  # process-wide singleton — isolate cases
        from fastapi.testclient import TestClient
        self.client = TestClient(appmod.app, raise_server_exceptions=False)

    def tearDown(self) -> None:
        appmod.ENGINE = self._orig_engine

    def test_unhandled_exception_returns_sanitized_json(self) -> None:
        secret = "SECRET_internal_state_boom"

        class _ExplodingEngine:
            metrics = fake_engine._FakeMetrics()

            def submit(self, *a, **k):
                raise ValueError(secret)  # not AdmissionRejected — unhandled

        appmod.ENGINE = _ExplodingEngine()
        with self.assertLogs("gravitone", level="ERROR") as logs:
            resp = self.client.post(
                "/v1/text-to-speech/alba",
                params={"output_format": "wav_24000"},
                json={"text": "hello"},
            )
        self.assertEqual(resp.status_code, 500)
        detail = resp.json()["detail"]  # would raise on a plain-text body
        self.assertTrue(detail.startswith("internal error (request "))
        self.assertNotIn(secret, detail)
        self.assertTrue(any(secret in r.getMessage() for r in logs.records))


class UnknownVoiceTests(unittest.TestCase):
    """A typo'd voice id is the caller's 404, not a sanitized 500 (previously
    it fell through to a model load whose exception read 'synthesis failed')."""

    def setUp(self) -> None:
        self._orig_engine = appmod.ENGINE
        appmod.SYNTH_CACHE.clear()  # process-wide singleton — isolate cases
        self.engine = fake_engine.FakeEngine(workers=1, delay=0.01)
        appmod.ENGINE = self.engine
        from fastapi.testclient import TestClient
        self.client = TestClient(appmod.app, raise_server_exceptions=False)

    def tearDown(self) -> None:
        appmod.ENGINE = self._orig_engine
        self.engine.close()

    def test_unknown_voice_id_is_404(self) -> None:
        resp = self.client.post(
            "/v1/text-to-speech/definitely-not-a-voice",
            params={"output_format": "wav_24000"},
            json={"text": "hello"},
        )
        self.assertEqual(resp.status_code, 404)
        self.assertIn("unknown voice", resp.json()["detail"])

    def test_unknown_voice_id_is_404_on_stream(self) -> None:
        resp = self.client.post(
            "/v1/text-to-speech/definitely-not-a-voice/stream",
            params={"output_format": "pcm_24000"},
            json={"text": "hello"},
        )
        self.assertEqual(resp.status_code, 404)

    def test_builtin_voice_still_synthesizes(self) -> None:
        resp = self.client.post(
            "/v1/text-to-speech/alba",
            params={"output_format": "wav_24000"},
            json={"text": "hello"},
        )
        self.assertEqual(resp.status_code, 200)


class JobExpiredShapeTests(unittest.TestCase):
    """Every unknown/expired-job response uses the ONE canonical shape from
    service.errors.job_expired — previously the same condition had two schemas
    in the same file (ingest_api.py)."""

    def test_all_job_routes_return_the_canonical_shape(self) -> None:
        from fastapi.testclient import TestClient
        client = TestClient(appmod.app, raise_server_exceptions=False)
        requests = [
            ("GET", "/v1/ingest/nope", {}),
            ("GET", "/v1/ingest/nope/speaker-preview/s1", {}),
            ("POST", "/v1/ingest/nope/speaker", {"json": {"speaker_id": "s1"}}),
            ("GET", "/v1/ingest/nope/preview/happy", {}),
            ("POST", "/v1/ingest/nope/commit",
             {"json": {"character": "X", "emotions": ["happy"],
                       "attested": True, "statement": "mine"}}),
            ("DELETE", "/v1/ingest/nope", {}),
        ]
        for method, url, kwargs in requests:
            with self.subTest(route=f"{method} {url}"):
                resp = client.request(method, url, **kwargs)
                self.assertEqual(resp.status_code, 404)
                body = resp.json()
                self.assertEqual(body["status"], "expired")
                self.assertEqual(body["detail"], "job not found or expired")


if __name__ == "__main__":
    unittest.main()
