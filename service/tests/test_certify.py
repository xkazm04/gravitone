"""Certification refuses to sign numbers it cannot substantiate.

The certificate is the product's headline performance claim. A load-test run
whose responses came from the synthesis cache measures an LRU lookup — its
realtime factor is fiction — so the bar starts with "did this run exercise the
model at all", and results produced before the harness knew the cache existed
(schema < 3) cannot answer that question and are refused on sight.

Pure over dicts: no server, no torch.
"""
from __future__ import annotations

import unittest

from service import certify
from service import loadtest as lt


def _level(**over) -> dict:
    row = {"concurrency": 1, "ok": 20, "rejected_429": 0, "errors": 0,
           "timeouts": 0, "server_rtf_mean": 2.5, "audio_s_per_wall_s": 3.0,
           "cache_mode": "bypass", "cache_hits": 0, "measures_synthesis": True}
    row.update(over)
    return row


def _result(rows=None, cache_mode="bypass", schema=lt.SCHEMA_VERSION) -> dict:
    rows = rows if rows is not None else [_level()]
    return {
        "schema_version": schema,
        "levels": rows,
        "recommended_cap": 1,
        "cache_mode": cache_mode,
        "measurement": lt.measurement_block(rows, cache_mode),
    }


class MeasurementStatusTests(unittest.TestCase):
    def test_clean_bypass_run_measures_synthesis(self) -> None:
        st = certify.measurement_status(_result())
        self.assertTrue(st["measures_synthesis"])
        self.assertEqual(st["cache_hits_total"], 0)
        self.assertEqual(st["reasons"], [])

    def test_cache_hits_disqualify_the_run(self) -> None:
        st = certify.measurement_status(_result([_level(cache_hits=4)]))
        self.assertFalse(st["measures_synthesis"])
        self.assertEqual(st["cache_hits_total"], 4)

    def test_cache_allowed_mode_disqualifies_the_run(self) -> None:
        st = certify.measurement_status(_result(cache_mode="allow"))
        self.assertFalse(st["measures_synthesis"])

    def test_pre_fix_result_schema_is_refused(self) -> None:
        # A v2 result carries no cache accounting AT ALL: it may be 100% cache
        # hits and there is no way to tell. Absence of evidence is not evidence.
        old = {"schema_version": 2, "levels": [_level()], "recommended_cap": 1}
        old["levels"][0].pop("cache_hits")
        st = certify.measurement_status(old)
        self.assertFalse(st["measures_synthesis"])
        self.assertIn("schema", st["reasons"][0])


class VerdictTests(unittest.TestCase):
    def _verdict(self, result: dict) -> dict:
        return certify.evaluate(result)

    def test_clean_run_certifies(self) -> None:
        ev = self._verdict(_result())
        self.assertEqual(ev["verdict"], "certified")
        self.assertTrue(ev["measurement"]["measures_synthesis"])

    def test_cache_contaminated_run_fails_even_with_great_numbers(self) -> None:
        # Spectacular rtf, zero errors — and entirely fictional.
        rows = [_level(server_rtf_mean=900000.0, cache_hits=19)]
        ev = self._verdict(_result(rows))
        self.assertEqual(ev["verdict"], "failed")
        failed = [c["check"] for c in ev["checks"] if not c["pass"]]
        self.assertEqual(failed, ["measures_synthesis"])

    def test_old_result_cannot_mint_a_v2_certificate(self) -> None:
        old = {"schema_version": 2, "levels": [_level()], "recommended_cap": 1}
        cert = certify.build_certificate(old)
        self.assertEqual(cert["verdict"], "failed")
        self.assertEqual(cert["version"], "gravitone-cert/2")


class CertVersionTests(unittest.TestCase):
    def test_version_bumped_so_old_artifacts_are_distinguishable(self) -> None:
        # v1 certificates were issued from cache-blind results; a consumer must
        # be able to tell them apart from a v2 measurement of the model.
        self.assertEqual(certify.CERT_VERSION, "gravitone-cert/2")
        self.assertEqual(certify.MIN_RESULT_SCHEMA, 3)
        # Today's harness must produce results the bar accepts.
        self.assertGreaterEqual(lt.SCHEMA_VERSION, certify.MIN_RESULT_SCHEMA)

    def test_certificate_still_hashes_and_verifies(self) -> None:
        cert = certify.build_certificate(_result())
        self.assertTrue(certify.verify_certificate(cert))
        cert["capacity"]["single_stream_rtf"] = 99.0   # tamper
        self.assertFalse(certify.verify_certificate(cert))


if __name__ == "__main__":
    unittest.main()
