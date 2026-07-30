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

    def test_old_result_cannot_mint_a_current_certificate(self) -> None:
        old = {"schema_version": 2, "levels": [_level()], "recommended_cap": 1}
        cert = certify.build_certificate(old)
        self.assertEqual(cert["verdict"], "failed")
        # Whatever the current version is, a cache-blind result never mints it.
        self.assertEqual(cert["version"], certify.CERT_VERSION)


class CertificateTopologyTests(unittest.TestCase):
    """The certificate must not restate a sampled counter as a pool aggregate."""

    def test_reuse_port_run_says_its_counters_are_a_sample(self) -> None:
        result = _result()
        result["topology"] = lt.topology_block("replicas", 4, [], lt.SCOPE_SAMPLE)
        cert = certify.build_certificate(result)
        topo = cert["topology"]
        self.assertEqual(topo["server_metrics_scope"], lt.SCOPE_SAMPLE)
        self.assertFalse(topo["pool_aggregate_available"])
        self.assertIn("NOT pool totals", topo["server_metrics_note"])
        # Sampled counters do not invalidate the client-side measurement.
        self.assertEqual(cert["verdict"], "certified")

    def test_addressable_run_may_claim_a_pool_aggregate(self) -> None:
        result = _result()
        result["topology"] = lt.topology_block("replicas", 4, [],
                                               lt.SCOPE_POOL_TOTAL)
        topo = certify.topology_status(result)
        self.assertTrue(topo["pool_aggregate_available"])

    def test_result_without_topology_claims_nothing(self) -> None:
        topo = certify.topology_status(_result())
        self.assertEqual(topo["server_metrics_scope"], "unknown")
        self.assertFalse(topo["pool_aggregate_available"])


class CertVersionTests(unittest.TestCase):
    def test_version_bumped_so_old_artifacts_are_distinguishable(self) -> None:
        # v1 was cache-blind; v2 measured a closed-loop concurrency ramp; v3
        # can additionally promise an arrival rate at an SLO. A consumer must
        # be able to tell which measurement basis it is holding.
        self.assertEqual(certify.CERT_VERSION, "gravitone-cert/3")
        self.assertEqual(certify.MIN_RESULT_SCHEMA, 3)
        # Today's harness must produce results the bar accepts.
        self.assertGreaterEqual(lt.SCHEMA_VERSION, certify.MIN_RESULT_SCHEMA)

    def test_v2_certificates_remain_verifiable(self) -> None:
        # Extending the issuing bar must not orphan artifacts already in the
        # wild: a v2 certificate's integrity still checks out, and still fails
        # on tamper.
        self.assertIn("gravitone-cert/2", certify.SUPPORTED_CERT_VERSIONS)
        self.assertIn(certify.CERT_VERSION, certify.SUPPORTED_CERT_VERSIONS)
        v2 = certify.build_certificate(_result())
        v2["version"] = "gravitone-cert/2"
        v2.pop("signature", None)
        v2["sha256"] = certify.hashlib.sha256(certify._canonical(v2)).hexdigest()
        self.assertTrue(certify.verify_certificate(v2))
        v2["capacity"]["recommended_cap"] = 999
        self.assertFalse(certify.verify_certificate(v2))

    def test_v2_signed_certificate_still_verifies_with_the_secret(self) -> None:
        secret = "s3cret"
        v2 = certify.build_certificate(_result())
        v2["version"] = "gravitone-cert/2"
        v2.pop("signature", None)
        v2["sha256"] = certify.hashlib.sha256(certify._canonical(v2)).hexdigest()
        v2["signature"] = {"alg": "HMAC-SHA256", "value": certify.hmac.new(
            secret.encode(), certify._canonical(v2),
            certify.hashlib.sha256).hexdigest()}
        self.assertTrue(certify.verify_certificate(v2, secret))
        self.assertFalse(certify.verify_certificate(v2, "wrong"))

    def test_certificate_still_hashes_and_verifies(self) -> None:
        cert = certify.build_certificate(_result())
        self.assertTrue(certify.verify_certificate(cert))
        cert["capacity"]["single_stream_rtf"] = 99.0   # tamper
        self.assertFalse(certify.verify_certificate(cert))


# ---------------------------------------------------------------------------
# The fourth check: an SLO capacity contract, or an explicit absence of one
# ---------------------------------------------------------------------------
def _slo(**over) -> dict:
    blk = {"p95_s": 2.0, "violations_max": 0.01, "max_rate_rps": 7.4,
           "candidate_rate_rps": 7.4, "first_failing_rate_rps": 8.0,
           "soak_minutes": 30, "soak_passed": True, "think_time_s": 30.0,
           "concurrent_users": 222, "predicted": False, "note": "ok"}
    blk.update(over)
    return blk


def _slo_result(**over) -> dict:
    res = _result()
    res["slo"] = _slo(**over)
    res["workload"] = {"arrival": "poisson", "max_in_flight": 64,
                       "refused_in_flight_total": 0}
    return res


class SloContractTests(unittest.TestCase):
    def test_a_ramp_only_run_promises_nothing_and_still_certifies(self) -> None:
        # Every pre-existing (v2-era) closed-loop result: no SLO was declared,
        # so there is nothing to refuse — but there is also no contract.
        ev = certify.evaluate(_result())
        check = next(c for c in ev["checks"] if c["check"] == "sustains_slo")
        self.assertTrue(check["pass"])
        self.assertIn("no SLO declared", check["got"])
        self.assertIsNone(ev["capacity_contract"])
        self.assertEqual(ev["verdict"], "certified")

    def test_a_measured_contract_is_signed(self) -> None:
        ev = certify.evaluate(_slo_result())
        self.assertEqual(ev["verdict"], "certified")
        contract = ev["capacity_contract"]
        self.assertEqual(contract["max_rate_rps"], 7.4)
        self.assertEqual(contract["soak_minutes"], 30)
        self.assertEqual(contract["concurrent_users"], 222)
        self.assertEqual(contract["slo"], {"p95_s": 2.0, "violations_max": 0.01})
        self.assertIn("think_time_s", contract["concurrent_users_basis"])

    def test_a_predicted_rate_is_refused(self) -> None:
        # Mirrors measures_synthesis: a fitted curve is a hypothesis about a
        # box, a certificate is a promise about one.
        ev = certify.evaluate(_slo_result(predicted=True))
        self.assertEqual(ev["verdict"], "failed")
        failed = [c["check"] for c in ev["checks"] if not c["pass"]]
        self.assertEqual(failed, ["sustains_slo"])
        self.assertIsNone(ev["capacity_contract"])
        self.assertIn("PREDICTED", ev["slo"]["reasons"][0])

    def test_a_failed_soak_refuses_the_contract(self) -> None:
        ev = certify.evaluate(_slo_result(soak_passed=False))
        self.assertEqual(ev["verdict"], "failed")
        self.assertIsNone(ev["capacity_contract"])
        self.assertIn("not sustainable", ev["slo"]["reasons"][0])

    def test_no_sustainable_rate_refuses_the_contract(self) -> None:
        ev = certify.evaluate(_slo_result(max_rate_rps=None,
                                          note="no offered rate met the SLO"))
        self.assertEqual(ev["verdict"], "failed")
        self.assertFalse(ev["slo"]["sustains_slo"])

    def test_a_cache_contaminated_slo_run_fails_the_first_check_too(self) -> None:
        res = _slo_result()
        res["levels"] = [_level(cache_hits=9)]
        res["measurement"] = lt.measurement_block(res["levels"], "bypass")
        ev = certify.evaluate(res)
        self.assertEqual(ev["verdict"], "failed")
        self.assertIn("measures_synthesis",
                      [c["check"] for c in ev["checks"] if not c["pass"]])

    def test_contract_travels_into_the_signed_certificate(self) -> None:
        cert = certify.build_certificate(_slo_result())
        self.assertEqual(cert["version"], "gravitone-cert/3")
        self.assertEqual(cert["capacity_contract"]["max_rate_rps"], 7.4)
        self.assertTrue(certify.verify_certificate(cert))
        cert["capacity_contract"]["max_rate_rps"] = 99.0   # tamper
        self.assertFalse(certify.verify_certificate(cert))


class OpenLoopResultEndToEndTests(unittest.TestCase):
    """A result built by the open-loop harness certifies without hand-editing."""

    def test_loadtest_open_loop_output_is_certifiable(self) -> None:
        results = {"lat": [0.5] * 60, "ttfb": [], "rtf": [2.5] * 60,
                   "audio": [3.0] * 60, "rejected": 0, "errors": 0,
                   "timeouts": 0, "unsupported": 0, "cache_hits": 0}
        row = lt.open_loop_row(offered_rate=6.0, duration_s=10.0, scheduled=60,
                               refused=0, results=results, wall_s=10.0,
                               slo_p95=2.0, peak_in_flight=4)
        slo = lt.slo_block(slo_p95=2.0, violations_max=0.01, max_rate=6.0,
                           first_fail=None, soak_minutes=5, soak_ok=True)
        result = lt.build_result(
            [row], knee=None, recommended=lt.open_loop_recommended_cap([row], slo),
            route="synth", fmt="wav_24000", corpus="workload:typical seed=0",
            service_config={}, meta=lt.runtime_metadata(), cache_mode="bypass",
            extra={"slo": slo, "workload": lt.workload_block(
                rates=[6.0], duration_s=10.0, seed=0, profile="typical",
                max_in_flight=64, rows=[row])})
        cert = certify.build_certificate(result)
        self.assertEqual(cert["verdict"], "certified")
        self.assertEqual(cert["capacity"]["recommended_cap"], 4)
        self.assertEqual(cert["capacity_contract"]["max_rate_rps"], 6.0)
        self.assertEqual(cert["capacity_contract"]["concurrent_users"], 180)


if __name__ == "__main__":
    unittest.main()
