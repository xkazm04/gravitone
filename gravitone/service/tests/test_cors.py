"""Browser access: the preflight, the exposed headers, and the closed default.

The "drop-in ElevenLabs compatibility" claim is a browser claim — the JS SDK
runs in a page, so it dies at the preflight unless CORS is configured. These
tests pin the three things that make it real without making it reckless:

  1. DEFAULT CLOSED. No TTS_CORS_ORIGINS -> no middleware, no Access-Control-*
     on a preflight. This service also mounts /v1/keys and /v1/ingest.
  2. A named origin gets a working preflight for the methods and headers the
     API really uses (POST + xi-api-key / Authorization / Content-Type).
  3. The custom response headers are EXPOSED, or a successful cross-origin
     request still can't read X-Cache / X-Realtime-Factor / Retry-After.

The app's own middleware is decided at import from the environment, and the
package pins TTS_API_KEY/env to open-mode defaults, so the enabled cases are
exercised by building a throwaway app from the same `cors_policy()` the real
app is wired with.
"""
from __future__ import annotations

import dataclasses
import inspect
import re
import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

ORIGIN = "https://studio.example.com"


def _app_with(**overrides) -> TestClient:
    """A minimal app carrying the policy `cors_policy` derives for `overrides`."""
    settings = dataclasses.replace(appmod.SETTINGS, **overrides)
    policy = appmod.cors_policy(settings)
    app = FastAPI()

    @app.post("/v1/text-to-speech/{voice_id}")
    def _speak(voice_id: str):  # pragma: no cover - trivial stub
        return {"voice": voice_id}

    if policy is not None:
        app.add_middleware(CORSMiddleware, **policy)
    return TestClient(app)


def _preflight(client: TestClient, origin: str = ORIGIN,
               method: str = "POST", headers: str = "xi-api-key,content-type"):
    return client.options(
        "/v1/text-to-speech/alba",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": headers,
        },
    )


class ClosedByDefaultTests(unittest.TestCase):
    def test_no_origins_configured_means_no_middleware(self) -> None:
        self.assertIsNone(appmod.cors_policy(
            dataclasses.replace(appmod.SETTINGS, cors_origins="",
                                cors_origin_regex="")))

    def test_default_app_preflight_grants_nothing(self) -> None:
        # The shipped app in this suite's env (no TTS_CORS_ORIGINS): a browser
        # gets no allow header, so the request never leaves the page.
        client = TestClient(appmod.app, raise_server_exceptions=False)
        resp = _preflight(client)
        self.assertNotIn("access-control-allow-origin", resp.headers)

    def test_unlisted_origin_is_refused(self) -> None:
        client = _app_with(cors_origins=ORIGIN)
        resp = _preflight(client, origin="https://evil.example")
        self.assertNotIn("access-control-allow-origin", resp.headers)


class PreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = _app_with(cors_origins=f"{ORIGIN},http://localhost:3000")

    def test_named_origin_preflight_succeeds(self) -> None:
        resp = _preflight(self.client)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers["access-control-allow-origin"], ORIGIN)
        allowed = resp.headers["access-control-allow-methods"]
        for method in ("GET", "POST", "PATCH", "DELETE"):
            self.assertIn(method, allowed)
        granted = resp.headers["access-control-allow-headers"].lower()
        for header in ("xi-api-key", "authorization", "content-type"):
            self.assertIn(header, granted)
        self.assertEqual(resp.headers["access-control-max-age"],
                         str(appmod.SETTINGS.cors_max_age))

    def test_second_configured_origin_also_works(self) -> None:
        resp = _preflight(self.client, origin="http://localhost:3000")
        self.assertEqual(resp.headers["access-control-allow-origin"],
                         "http://localhost:3000")

    def test_actual_request_exposes_the_custom_headers(self) -> None:
        resp = self.client.post("/v1/text-to-speech/alba",
                                headers={"Origin": ORIGIN})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers["access-control-allow-origin"], ORIGIN)
        exposed = {h.strip().lower()
                   for h in resp.headers["access-control-expose-headers"].split(",")}
        for header in ("x-cache", "x-realtime-factor", "x-synth-seconds",
                       "x-queue-seconds", "x-segments", "x-ignored-settings",
                       "retry-after"):
            self.assertIn(header, exposed)

    def test_regex_origin_policy(self) -> None:
        client = _app_with(cors_origins="",
                           cors_origin_regex=r"https://.*\.tenant\.example")
        ok = _preflight(client, origin="https://a.tenant.example")
        self.assertEqual(ok.headers.get("access-control-allow-origin"),
                         "https://a.tenant.example")
        bad = _preflight(client, origin="https://tenant.example.evil")
        self.assertNotIn("access-control-allow-origin", bad.headers)


class WildcardTests(unittest.TestCase):
    def test_wildcard_is_opt_in_only(self) -> None:
        policy = appmod.cors_policy(
            dataclasses.replace(appmod.SETTINGS, cors_origins="*"))
        self.assertEqual(policy["allow_origins"], ["*"])

    def test_wildcard_refuses_credentials(self) -> None:
        # Credentials + "*" is invalid per the CORS spec; the weaker guarantee
        # is dropped rather than emitting a policy every browser rejects.
        policy = appmod.cors_policy(dataclasses.replace(
            appmod.SETTINGS, cors_origins="*", cors_allow_credentials=True))
        self.assertFalse(policy["allow_credentials"])

    def test_credentials_honoured_for_named_origins(self) -> None:
        policy = appmod.cors_policy(dataclasses.replace(
            appmod.SETTINGS, cors_origins=ORIGIN, cors_allow_credentials=True))
        self.assertTrue(policy["allow_credentials"])


class ExposeHeaderDriftTests(unittest.TestCase):
    """Every custom header the routes set must be in CORS_EXPOSE_HEADERS.

    A header a browser client cannot read is a header that does not exist for
    the drop-in SDK. If you add one in app.py, add it here too.
    """

    def test_every_x_header_in_app_is_exposed(self) -> None:
        source = inspect.getsource(appmod)
        used = set(re.findall(r'"(X-[A-Za-z][A-Za-z0-9-]*)"', source))
        exposed = {h.lower() for h in appmod.CORS_EXPOSE_HEADERS}
        for header in sorted(used):
            with self.subTest(header=header):
                self.assertIn(header.lower(), exposed,
                              f"{header} is set by a route but not exposed to "
                              "browser clients — add it to CORS_EXPOSE_HEADERS")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
