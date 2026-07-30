"""Certification refuses to sign numbers it cannot substantiate.

The certificate is the product's headline performance claim. A load-test run
whose responses came from the synthesis cache measures an LRU lookup — its
realtime factor is fiction — so the bar starts with "did this run exercise the
model at all", and results produced before the harness knew the cache existed
(schema < 3) cannot answer that question and are refused on sight.

Pure over dicts: no server, no torch.
"""
from __future__ import annotations

import pathlib
import tempfile
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


# ---------------------------------------------------------------------------
# The performance ledger: append-only, and it says so under pressure
# ---------------------------------------------------------------------------
class LedgerFingerprintTests(unittest.TestCase):
    def test_same_box_same_fingerprint(self) -> None:
        hw = {"machine": "aarch64", "cpu_count": 8, "cpu_model": "Neoverse-V2",
              "processor": "", "memory_gb": 16.0}
        self.assertEqual(certify.hw_fingerprint(hw, "c8g.2xlarge"),
                         certify.hw_fingerprint(dict(hw), "c8g.2xlarge"))

    def test_instance_type_separates_histories(self) -> None:
        hw = {"machine": "aarch64", "cpu_count": 8, "cpu_model": "Neoverse-V2"}
        self.assertNotEqual(certify.hw_fingerprint(hw, "c8g.2xlarge"),
                            certify.hw_fingerprint(hw, "m8g.xlarge"))

    def test_a_kernel_upgrade_is_not_a_new_box(self) -> None:
        # `system` carries the kernel release. Fingerprinting on it would start
        # a fresh history every apt upgrade - and a kernel change is exactly the
        # kind of thing the ledger exists to MEASURE, on the same series.
        a = {"machine": "aarch64", "cpu_count": 8, "cpu_model": "Neoverse-V2",
             "system": "Linux 6.8.0-31-generic"}
        b = dict(a, system="Linux 6.8.0-45-generic")
        self.assertEqual(certify.hw_fingerprint(a), certify.hw_fingerprint(b))

    def test_a_different_core_count_is_a_different_box(self) -> None:
        a = {"machine": "aarch64", "cpu_count": 8}
        self.assertNotEqual(certify.hw_fingerprint(a),
                            certify.hw_fingerprint(dict(a, cpu_count=2)))


class LedgerAppendTests(unittest.TestCase):
    """Verify -> append -> never rewrite. The whole contract, exercised on disk."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self._tmp.name) / "certifications"
        self.addCleanup(self._tmp.cleanup)

    def _cert(self, **result_over) -> tuple[dict, dict]:
        result = _result()
        result.update({"git_sha": "abc1234", "torch_version": "2.9.0",
                       "onednn_fpmath_mode": "bf16"})
        result.update(result_over)
        return certify.build_certificate(result), result

    def _ledger(self) -> dict:
        return certify.load_ledger(self.dir / certify.LEDGER_INDEX)

    def test_append_writes_the_artifact_and_one_row(self) -> None:
        cert, result = self._cert()
        out = certify.append_ledger(cert, result, ledger_dir=self.dir,
                                    instance_type="c8g.2xlarge")
        self.assertTrue(out["appended"])
        row = out["row"]
        self.assertEqual(row["git_sha"], "abc1234")
        self.assertEqual(row["torch_version"], "2.9.0")
        self.assertEqual(row["fpmath"], "bf16")
        self.assertEqual(row["instance_type"], "c8g.2xlarge")
        self.assertEqual(row["verdict"], "certified")
        self.assertEqual(row["sha256"], cert["sha256"])
        self.assertEqual(row["cap"], cert["capacity"]["recommended_cap"])
        # The artifact really is on disk, at the documented path, verbatim.
        artifact = self.dir / row["cert_path"]
        self.assertTrue(artifact.exists())
        self.assertEqual(certify.json.loads(artifact.read_text("utf-8")), cert)
        self.assertEqual(len(self._ledger()["rows"]), 1)

    def test_row_carries_every_documented_field(self) -> None:
        cert, result = self._cert()
        row = certify.ledger_row(cert, result, "c8g.2xlarge")
        for field in ("hw_fingerprint", "cpu_model", "cores", "git_sha",
                      "issued", "torch_version", "fpmath", "single_stream_rtf",
                      "cap", "aud_s_at_cap", "verdict", "sha256"):
            self.assertIn(field, row)

    def test_appending_the_same_certificate_twice_is_a_no_op(self) -> None:
        cert, result = self._cert()
        certify.append_ledger(cert, result, ledger_dir=self.dir)
        again = certify.append_ledger(cert, result, ledger_dir=self.dir)
        self.assertFalse(again["appended"])
        self.assertIn("already row", again["reason"])
        self.assertEqual(len(self._ledger()["rows"]), 1)

    def test_re_certifying_one_result_does_not_duplicate_the_row(self) -> None:
        # The CLI path, which sha-only deduplication misses: `certify
        # --append-ledger` run twice over ONE result JSON mints two
        # certificates whose only difference is `issued`, and therefore two
        # different sha256 values. A retried CI step must not write the same
        # benchmark into history twice.
        cert, result = self._cert()
        certify.append_ledger(cert, result, ledger_dir=self.dir)
        reminted = certify.build_certificate(result)
        reminted["issued"] = "2099-01-01T00:00:00+00:00"
        reminted["sha256"] = certify.hashlib.sha256(
            certify._canonical(reminted)).hexdigest()
        self.assertNotEqual(reminted["sha256"], cert["sha256"])
        again = certify.append_ledger(reminted, result, ledger_dir=self.dir)
        self.assertFalse(again["appended"])
        self.assertIn("issuance timestamp", again["reason"])
        self.assertEqual(len(self._ledger()["rows"]), 1)

    def test_a_changed_measurement_at_the_same_commit_does_append(self) -> None:
        # The other side of the same rule: identical commit, DIFFERENT numbers
        # (a torch upgrade, a quieter box) is a new fact and must be recorded.
        cert, result = self._cert()
        certify.append_ledger(cert, result, ledger_dir=self.dir)
        newer = certify.build_certificate(dict(result, recommended_cap=2))
        out = certify.append_ledger(newer, dict(result, torch_version="2.10.0"),
                                    ledger_dir=self.dir)
        self.assertTrue(out["appended"])
        self.assertEqual(len(self._ledger()["rows"]), 2)

    def test_a_second_run_at_the_same_commit_keeps_both_artifacts(self) -> None:
        # Re-benchmarking one commit is normal (a noisy runner, a new torch).
        # Overwriting yesterday's certificate to make room is the rewrite this
        # module exists to refuse.
        first, result = self._cert()
        second = certify.build_certificate(dict(result, recommended_cap=2))
        self.assertNotEqual(first["sha256"], second["sha256"])
        a = certify.append_ledger(first, result, ledger_dir=self.dir)
        b = certify.append_ledger(second, result, ledger_dir=self.dir)
        self.assertTrue(b["appended"])
        self.assertNotEqual(a["row"]["cert_path"], b["row"]["cert_path"])
        self.assertTrue((self.dir / a["row"]["cert_path"]).exists())
        self.assertTrue((self.dir / b["row"]["cert_path"]).exists())
        self.assertEqual(len(self._ledger()["rows"]), 2)

    def test_history_is_only_ever_extended(self) -> None:
        cert, result = self._cert()
        certify.append_ledger(cert, result, ledger_dir=self.dir)
        first_row = dict(self._ledger()["rows"][0])
        other = certify.build_certificate(dict(result, recommended_cap=2))
        certify.append_ledger(other, dict(result, git_sha="def5678"),
                              ledger_dir=self.dir)
        rows = self._ledger()["rows"]
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], first_row)   # untouched, byte for byte

    def test_an_unverifiable_certificate_is_never_recorded(self) -> None:
        cert, result = self._cert()
        cert["capacity"]["single_stream_rtf"] = 99.0     # tamper before append
        with self.assertRaises(certify.LedgerIntegrityError):
            certify.append_ledger(cert, result, ledger_dir=self.dir)
        self.assertEqual(self._ledger()["rows"], [])


class LedgerIntegrityTests(unittest.TestCase):
    """A ledger whose rows stopped matching their certificates is not extended."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self._tmp.name) / "certifications"
        self.addCleanup(self._tmp.cleanup)
        result = _result()
        result.update({"git_sha": "abc1234", "torch_version": "2.9.0",
                       "onednn_fpmath_mode": "bf16"})
        self.result = result
        self.cert = certify.build_certificate(result)
        certify.append_ledger(self.cert, result, ledger_dir=self.dir,
                              instance_type="c8g.2xlarge")
        self.index = self.dir / certify.LEDGER_INDEX

    def _rows(self) -> list:
        return certify.load_ledger(self.index)["rows"]

    def _rewrite(self, rows) -> None:
        doc = certify.load_ledger(self.index)
        doc["rows"] = rows
        self.index.write_text(certify.json.dumps(doc, indent=2), "utf-8")

    def test_a_clean_ledger_verifies(self) -> None:
        report = certify.verify_ledger(certify.load_ledger(self.index), self.dir)
        self.assertTrue(report["ok"])
        self.assertEqual(report["tampered"], [])
        self.assertEqual(report["unverifiable"], [])

    def test_an_edited_historical_row_is_detected_and_named(self) -> None:
        rows = self._rows()
        rows[0]["single_stream_rtf"] = 42.0      # flatter the history
        self._rewrite(rows)
        report = certify.verify_ledger(certify.load_ledger(self.index), self.dir)
        self.assertFalse(report["ok"])
        self.assertEqual(report["tampered"][0]["fields"], ["single_stream_rtf"])

    def test_an_edited_historical_row_refuses_the_next_append(self) -> None:
        rows = self._rows()
        rows[0]["cap"] = 64
        self._rewrite(rows)
        other = certify.build_certificate(dict(self.result, recommended_cap=2))
        with self.assertRaises(certify.LedgerIntegrityError) as ctx:
            certify.append_ledger(other, dict(self.result, git_sha="def5678"),
                                  ledger_dir=self.dir)
        self.assertIn("cap", str(ctx.exception))
        self.assertEqual(len(self._rows()), 1)   # nothing was appended

    def test_an_edited_certificate_artifact_is_detected(self) -> None:
        artifact = self.dir / self._rows()[0]["cert_path"]
        cert = certify.json.loads(artifact.read_text("utf-8"))
        cert["capacity"]["recommended_cap"] = 99
        artifact.write_text(certify.json.dumps(cert, indent=2), "utf-8")
        report = certify.verify_ledger(certify.load_ledger(self.index), self.dir)
        self.assertFalse(report["ok"])
        self.assertIn("integrity check", report["tampered"][0]["reason"])

    def test_a_renamed_artifact_breaks_the_git_sha_binding(self) -> None:
        rows = self._rows()
        rows[0]["git_sha"] = "0000000"
        self._rewrite(rows)
        report = certify.verify_ledger(certify.load_ledger(self.index), self.dir)
        self.assertIn("git_sha", report["tampered"][0]["fields"])

    def test_a_pruned_artifact_is_unverifiable_but_not_fatal(self) -> None:
        # The proposal keeps a full certificate only for verdict changes, so a
        # missing artifact is an expected state: report it, do not refuse.
        (self.dir / self._rows()[0]["cert_path"]).unlink()
        report = certify.verify_ledger(certify.load_ledger(self.index), self.dir)
        self.assertTrue(report["ok"])
        self.assertEqual(len(report["unverifiable"]), 1)
        other = certify.build_certificate(dict(self.result, recommended_cap=2))
        self.assertTrue(certify.append_ledger(
            other, dict(self.result, git_sha="def5678"),
            ledger_dir=self.dir)["appended"])

    def test_a_corrupt_index_is_never_silently_replaced(self) -> None:
        self.index.write_text("{not json", "utf-8")
        with self.assertRaises(certify.LedgerIntegrityError):
            certify.load_ledger(self.index)

    def test_newest_row_for_a_hardware_class_is_the_last_appended(self) -> None:
        fp = self._rows()[0]["hw_fingerprint"]
        second = certify.build_certificate(dict(self.result, recommended_cap=2))
        certify.append_ledger(second, dict(self.result, git_sha="def5678"),
                              ledger_dir=self.dir, instance_type="c8g.2xlarge")
        ledger = certify.load_ledger(self.index)
        self.assertEqual(certify.newest_row(ledger, fp)["sha256"],
                         second["sha256"])
        self.assertIsNone(certify.newest_row(ledger, "not-a-fingerprint"))


class LedgerDocsTests(unittest.TestCase):
    """The checked-in ledger directory is a layout + a schema, not fake data."""

    ROOT = pathlib.Path(__file__).resolve().parents[2] / "docs" / "certifications"

    def test_readme_documents_the_row_schema(self) -> None:
        text = (self.ROOT / "README.md").read_text("utf-8")
        for field in ("hw_fingerprint", "git_sha", "single_stream_rtf",
                      "aud_s_at_cap", "sha256"):
            self.assertIn(field, text)

    def test_the_checked_in_ledger_is_empty_and_verifies(self) -> None:
        # No box on the authoring machine ran the benchmark, so an invented row
        # here would be exactly the fabrication the certificate refuses to sign.
        ledger = certify.load_ledger(self.ROOT / certify.LEDGER_INDEX)
        self.assertEqual(ledger["version"], certify.LEDGER_VERSION)
        self.assertEqual(ledger["rows"], [])
        self.assertTrue(certify.verify_ledger(ledger, self.ROOT)["ok"])


if __name__ == "__main__":
    unittest.main()
