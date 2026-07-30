"""Can a caller tell "no key" apart from "valid key, wrong scope"?

READ-ONLY PROBE. Nothing in `service/` is changed by this file; it exists
because the studio's Proving Ledger (web/app/keys) builds a privilege matrix
out of what the deployment answers, and the meaning of a refusal depends
entirely on the answer to that question.

Since the batch-3 integration the answer is YES: `_authorize` answers 403 for
a recognised-but-unscoped key (`keys.key_recognized`, same constant-time scan
discipline as validate_key) and 401 only when no credential is recognised at
all. These tests PIN that distinction. The studio's sweep still keeps its
`negativesAreConclusive` belt-and-suspenders (a deployment running an older
service answers 401 for both), but on a current box a negative probe is
conclusive on its own.

Same harness as test_auth.py: rebind `service.auth.SETTINGS` (frozen
dataclass) and stub `validate_key` + `key_recognized`; the environment is
never touched.
"""
from __future__ import annotations

import dataclasses
import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
import service.auth as auth
from fastapi.testclient import TestClient

ROOT = "root-key-for-tests"
MANAGED = "managed-tts-only"


class AuthRefusalDistinctionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._settings = auth.SETTINGS
        self._validate = auth.validate_key
        self._recognized = auth.key_recognized
        self._engine = appmod.ENGINE
        auth.SETTINGS = dataclasses.replace(auth.SETTINGS, api_key=ROOT)
        # A real, recognised managed key that holds `tts` and nothing else.
        auth.validate_key = (
            lambda secret, scope: secret == MANAGED and scope == "tts")
        auth.key_recognized = lambda secret: secret == MANAGED
        self.engine = fake_engine.FakeEngine(workers=1, delay=0.01)
        appmod.ENGINE = self.engine
        self.client = TestClient(appmod.app, raise_server_exceptions=False)

    def tearDown(self) -> None:
        auth.SETTINGS = self._settings
        auth.validate_key = self._validate
        auth.key_recognized = self._recognized
        appmod.ENGINE = self._engine
        self.engine.close()

    def _performance(self, headers: dict | None = None):
        # /v1/performance requires the `performance` scope, which MANAGED lacks.
        return self.client.post("/v1/performance", json={}, headers=headers or {})

    def test_no_key_and_wrong_scope_are_distinguishable(self) -> None:
        """The distinction the Proving Ledger measures, pinned.

        Anonymous = 401 (nothing recognised). A real key without the scope =
        403 naming the scope it lacks — a negative probe is conclusive on its
        own against a current service.
        """
        anonymous = self._performance()
        wrong_scope = self._performance({"xi-api-key": MANAGED})
        self.assertEqual(anonymous.status_code, 401)
        self.assertEqual(wrong_scope.status_code, 403)
        self.assertIn("performance", wrong_scope.json()["detail"])
        # An unrecognised (revoked/foreign) key is still a plain 401 — it must
        # not learn whether the scope even exists here.
        foreign = self._performance({"xi-api-key": "never-minted"})
        self.assertEqual(foreign.status_code, 401)
        self.assertEqual(anonymous.json(), foreign.json())

    def test_a_granted_scope_is_served_for_the_same_key(self) -> None:
        """Why the studio's sweep is still meaningful.

        The one thing that separates "unrecognised key" from "scope enforced"
        is a POSITIVE probe with the same secret coming back served.
        """
        ok = self.client.post(
            "/v1/text-to-speech/alba",
            params={"output_format": "wav_24000"},
            json={"text": "one"},
            headers={"xi-api-key": MANAGED},
        )
        self.assertEqual(ok.status_code, 200)

    def test_auth_answers_before_the_body_is_validated(self) -> None:
        """The probes send deliberately empty bodies; this is why that is safe.

        An unauthorized caller must get 401 — not 422 — so a probe never has to
        send a well-formed request (i.e. never has to make the service DO the
        work) to learn whether it would have been admitted.
        """
        self.assertEqual(self._performance().status_code, 401)
        # ...and an authorized caller with the same empty body gets as far as
        # validation, which is what the studio reads as "admitted".
        auth.validate_key = lambda secret, scope: secret == MANAGED
        self.assertEqual(self._performance({"xi-api-key": MANAGED}).status_code, 422)

    def test_probe_targets_that_must_stay_side_effect_free(self) -> None:
        """The two write-shaped probes must not change anything on a real box.

        A PATCH at a voice id nothing will ever have, and an empty-bodied POST,
        are the shapes the sweep sends; if either ever started succeeding, the
        Proving Ledger would be mutating the deployment it claims to observe.
        """
        patched = self.client.patch(
            "/v1/voices/gravitone-probe-no-such-voice", json={},
            headers={"xi-api-key": ROOT},
        )
        self.assertIn(patched.status_code, (404, 422))
        empty_perf = self._performance({"xi-api-key": ROOT})
        self.assertEqual(empty_perf.status_code, 422)


if __name__ == "__main__":
    unittest.main()
