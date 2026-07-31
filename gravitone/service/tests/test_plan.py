"""The deployment compiler plans only what a certificate can substantiate.

A plan is a deployment somebody will actually run, so the interesting tests are
the REFUSALS: a failing certificate, a predicted-only rate, a cache-contaminated
run and an unknown version must all produce a named reason and exit 2 rather
than a topology that carries the authority of a measurement without one behind
it. The rest pin the sizing law itself -- floors, ceilings, the SO_REUSEPORT
autoscaling caveat and ingest affinity -- on two real certified boxes.

Pure over dicts: no server, no torch, no network.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from service import certify
from service import plan as planmod


# --- fixture certificates ---------------------------------------------------
def _cert(hardware: dict, cap: int, *, version: str = "gravitone-cert/3",
          verdict: str = "certified", topology: dict | None = None,
          contract: dict | None = None, slo: dict | None = None,
          measurement: dict | None = None) -> dict:
    return {
        "version": version,
        "issued": "2026-07-30T00:00:00+00:00",
        "hardware": hardware,
        "topology": topology or {
            "mode": "replicas", "replicas": cap,
            "server_metrics_scope": "single_replica_sample",
            "server_metrics_note": "SO_REUSEPORT sample",
            "pool_aggregate_available": False,
        },
        "checks": [{"check": "realtime_single_stream", "pass": verdict == "certified"}],
        "measurement": measurement or {"measures_synthesis": True, "reasons": [],
                                       "cache_hits_total": 0},
        "slo": slo or {"declared": False, "predicted": False, "sustains_slo": False,
                       "reasons": []},
        "capacity_contract": contract,
        "verdict": verdict,
        "capacity": {"single_stream_rtf": 4.26, "recommended_cap": cap,
                     "audio_s_per_wall_s_at_cap": 10.8,
                     "audio_minutes_per_hour": 650},
        "recommended_config": {"TTS_WORKERS": 1, "replicas": cap,
                               "TTS_TORCH_THREADS": 2, "TTS_QUEUE_MAX": 16},
        "sha256": "0" * 64,
    }


def large_cert(**over) -> dict:
    """AWS Graviton4 c8g.2xlarge -- the certified production row."""
    return _cert({"machine": "aarch64", "system": "Linux 6.8",
                  "cpu_count": 8, "cpu_model": "Neoverse-V2", "memory_gb": 16.0},
                 4, **over)


def small_cert(**over) -> dict:
    """AWS Graviton2 t4g.small -- the certified free-tier row."""
    return _cert({"machine": "aarch64", "system": "Linux 6.8",
                  "cpu_count": 2, "cpu_model": "Neoverse-N1", "memory_gb": 2.0},
                 1, **over)


def failing_cert() -> dict:
    c = large_cert(verdict="failed")
    c["checks"] = [{"check": "measures_synthesis", "pass": False},
                   {"check": "realtime_single_stream", "pass": True}]
    return c


def predicted_cert() -> dict:
    """A v3 certificate whose rate was FITTED rather than observed."""
    return large_cert(
        slo={"declared": True, "predicted": True, "sustains_slo": False,
             "p95_s": 2.0, "max_rate_rps": None,
             "reasons": ["the rate is PREDICTED (fitted/extrapolated), not measured"]})


def contract_cert() -> dict:
    """A v3 certificate carrying a MEASURED capacity contract."""
    return large_cert(
        slo={"declared": True, "predicted": False, "sustains_slo": True,
             "p95_s": 2.0, "max_rate_rps": 3.0, "concurrent_users": 90},
        contract={"slo": {"p95_s": 2.0, "violations_max": 0},
                  "max_rate_rps": 3.0, "soak_minutes": 10,
                  "concurrent_users": 90,
                  "concurrent_users_basis": "max_rate_rps x think_time_s",
                  "measured": "open-loop Poisson arrivals"})


# --- refusals ---------------------------------------------------------------
class RefusalTests(unittest.TestCase):
    def _refusal(self, cert: dict) -> planmod.PlanRefused:
        with self.assertRaises(planmod.PlanRefused) as ctx:
            planmod.build_plan(cert)
        return ctx.exception

    def test_failing_certificate_is_refused_by_name(self) -> None:
        exc = self._refusal(failing_cert())
        self.assertEqual(exc.reason, planmod.REFUSE_FAILED_VERDICT)
        self.assertIn("measures_synthesis", exc.detail)

    def test_predicted_rate_is_refused(self) -> None:
        # certify refuses to SIGN a curve fit; the compiler refuses to size
        # from one. Same fact, same refusal.
        exc = self._refusal(predicted_cert())
        self.assertEqual(exc.reason, planmod.REFUSE_PREDICTED_ONLY)
        self.assertIn("PREDICTED", exc.detail)

    def test_v1_certificate_is_refused(self) -> None:
        exc = self._refusal(large_cert(version="gravitone-cert/1"))
        self.assertEqual(exc.reason, planmod.REFUSE_UNSUPPORTED_VERSION)

    def test_cache_contaminated_measurement_is_refused(self) -> None:
        exc = self._refusal(large_cert(measurement={
            "measures_synthesis": False,
            "reasons": ["4 response(s) were served from the synthesis cache"]}))
        self.assertEqual(exc.reason, planmod.REFUSE_UNMEASURED)
        self.assertIn("synthesis cache", exc.detail)

    def test_non_certificate_is_refused(self) -> None:
        self.assertEqual(self._refusal({"hello": "world"}).reason,
                         planmod.REFUSE_MALFORMED)

    def test_missing_cap_is_refused(self) -> None:
        cert = large_cert()
        cert["capacity"]["recommended_cap"] = 0
        self.assertEqual(self._refusal(cert).reason, planmod.REFUSE_UNMEASURED)

    def test_tampered_certificate_is_refused_under_verify(self) -> None:
        cert = large_cert()          # sha256 is a placeholder, not the real hash
        with self.assertRaises(planmod.PlanRefused) as ctx:
            planmod.build_plan(cert, verify=True)
        self.assertEqual(ctx.exception.reason, planmod.REFUSE_INTEGRITY)

    def test_verify_accepts_a_real_certificate(self) -> None:
        # Built by certify itself, so the hash is genuine (hardware is this box's;
        # only the integrity path is under test here).
        result = {"schema_version": 3, "recommended_cap": 1, "cache_mode": "bypass",
                  "levels": [{"concurrency": 1, "ok": 5, "errors": 0,
                              "rejected_429": 0, "server_rtf_mean": 2.5,
                              "audio_s_per_wall_s": 3.0, "cache_hits": 0}]}
        cert = certify.build_certificate(result)
        self.assertEqual(cert["verdict"], "certified")
        plan = planmod.build_plan(cert, verify=True)
        self.assertGreaterEqual(plan["replicas"], planmod.MIN_REPLICAS)


# --- sizing -----------------------------------------------------------------
class LargeBoxTests(unittest.TestCase):
    def setUp(self) -> None:
        self.plan = planmod.build_plan(large_cert())

    def test_replicas_and_threads_fill_the_box(self) -> None:
        # 8 cores, cap 4 -> 4 replicas x 2 threads = the whole box, which is
        # exactly what bootstrap's single container did NOT do.
        self.assertEqual(self.plan["replicas"], 4)
        self.assertEqual(self.plan["torch_threads"], 2)
        self.assertEqual(self.plan["queue_max"],
                         planmod.QUEUE_PER_REPLICA * 4)
        self.assertEqual(self.plan["resources"]["cpu"], "2")
        self.assertEqual(self.plan["resources"]["memory"],
                         f"{planmod.MEMORY_REQUEST_GI}Gi")

    def test_multi_replica_plan_runs_the_supervisor(self) -> None:
        self.assertFalse(self.plan["launcher"]["single_container"])
        self.assertEqual(self.plan["launcher"]["command"][:4],
                         ["python", "-m", "service.replicas", "--replicas"])

    def test_reuse_port_topology_picks_cpu_not_keda(self) -> None:
        # THE caveat: SO_REUSEPORT /metrics is a single-replica sample, so KEDA
        # on queue depth would scale the fleet off one arbitrary replica.
        self.assertEqual(self.plan["autoscaling"]["mode"], "cpu")
        self.assertIn("sample", self.plan["autoscaling"]["why"].lower())

    def test_sequential_port_topology_unlocks_keda(self) -> None:
        cert = large_cert(topology={"mode": "replicas", "replicas": 4,
                                    "server_metrics_scope": "pool_total",
                                    "pool_aggregate_available": True})
        auto = planmod.build_plan(cert)["autoscaling"]
        self.assertEqual(auto["mode"], "keda")
        self.assertEqual(auto["target"], planmod.KEDA_QUEUED_TARGET)

    def test_roles_split_and_ingest_is_affine(self) -> None:
        roles = self.plan["roles"]
        self.assertFalse(roles["colocated"])
        self.assertTrue(roles["ingest"]["affine"])
        self.assertEqual(roles["ingest"]["replicas"], planmod.INGEST_REPLICAS)
        self.assertFalse(roles["synth"]["affine"])
        self.assertEqual(
            roles["synth"]["replicas"] + roles["converse"]["replicas"]
            + roles["ingest"]["replicas"], self.plan["replicas"])

    def test_provenance_ties_the_plan_to_its_certificate(self) -> None:
        prov = self.plan["provenance"]
        self.assertEqual(prov["cert_sha"], "0" * 64)
        self.assertEqual(prov["cert_version"], "gravitone-cert/3")
        self.assertEqual(prov["plan_version"], planmod.PLAN_VERSION)
        self.assertEqual(len(prov["hw_fingerprint"]), 16)

    def test_fingerprint_changes_with_the_box(self) -> None:
        self.assertNotEqual(
            self.plan["provenance"]["hw_fingerprint"],
            planmod.build_plan(small_cert())["provenance"]["hw_fingerprint"])


class SmallBoxTests(unittest.TestCase):
    def setUp(self) -> None:
        self.plan = planmod.build_plan(small_cert())

    def test_one_replica_no_autoscaling_no_supervisor(self) -> None:
        self.assertEqual(self.plan["replicas"], 1)
        self.assertEqual(self.plan["autoscaling"]["mode"], "off")
        self.assertIsNone(self.plan["autoscaling"]["target"])
        self.assertTrue(self.plan["launcher"]["single_container"])

    def test_queue_floor_holds(self) -> None:
        self.assertEqual(self.plan["queue_max"], planmod.MIN_QUEUE_MAX)

    def test_memory_ceiling_is_named_not_silent(self) -> None:
        joined = " ".join(self.plan["notes"])
        self.assertIn("memory", joined)
        self.assertEqual(self.plan["resources"]["memory"],
                         f"{planmod.MIN_MEMORY_REQUEST_GI}Gi")

    def test_roles_are_colocated_on_a_small_box(self) -> None:
        roles = self.plan["roles"]
        self.assertTrue(roles["colocated"])
        self.assertTrue(roles["ingest"]["affine"])


class SizingBasisTests(unittest.TestCase):
    def test_v3_contract_is_preferred_over_the_ramp(self) -> None:
        plan = planmod.build_plan(contract_cert())
        self.assertEqual(plan["sizing"]["basis"], "capacity_contract")
        # Little's law: 3 req/s x 2s p95 = 6 in flight; the 8-core box allows it.
        self.assertEqual(plan["sizing"]["wanted_replicas"], 6)
        self.assertEqual(plan["sizing"]["max_rate_rps"], 3.0)

    def test_v2_certificate_falls_back_to_the_concurrency_cap(self) -> None:
        cert = large_cert(version="gravitone-cert/2")
        plan = planmod.build_plan(cert)
        self.assertEqual(plan["sizing"]["basis"], "concurrency_cap")
        self.assertIsNone(plan["sizing"]["max_rate_rps"])

    def test_cpu_ceiling_binds_and_says_so(self) -> None:
        # A contract that wants more replicas than the box has cores.
        cert = contract_cert()
        cert["capacity_contract"]["max_rate_rps"] = 20.0
        cert["capacity_contract"]["slo"]["p95_s"] = 3.0
        cert["hardware"]["memory_gb"] = 64.0   # so only the CPU ceiling binds
        plan = planmod.build_plan(cert)
        self.assertEqual(plan["replicas"], 8)          # == cpu_count
        self.assertTrue(any("CPU ceiling" in n for n in plan["notes"]))

    def test_thread_ceiling_binds_on_a_wide_box(self) -> None:
        cert = _cert({"machine": "aarch64", "cpu_count": 192,
                      "cpu_model": "Ampere", "memory_gb": 384.0}, 2)
        plan = planmod.build_plan(cert)
        self.assertEqual(plan["torch_threads"], planmod.MAX_TORCH_THREADS)
        self.assertTrue(any("thread floor/ceiling" in n for n in plan["notes"]))


# --- emitters ---------------------------------------------------------------
class EmitTests(unittest.TestCase):
    def test_helm_values_carry_the_measured_numbers(self) -> None:
        plan = planmod.build_plan(large_cert())
        out = planmod.emit_helm_values(plan)
        self.assertIn("replicaCount: 4", out)
        self.assertIn("torchThreads: 2", out)
        self.assertIn('mode: "cpu"', out)
        self.assertIn("GENERATED by python -m service.plan", out)
        self.assertIn("ingest", out)
        self.assertTrue(out.isascii())

    def test_compose_runs_the_supervisor_on_multi_replica_plans(self) -> None:
        out = planmod.emit_compose(planmod.build_plan(large_cert()))
        self.assertIn('"service.replicas", "--replicas", "4"', out)
        self.assertIn("stop_grace_period: 30s", out)
        self.assertIn("gravitone-ingest:/app/ingest_jobs", out)
        self.assertTrue(out.isascii())

    def test_compose_leaves_a_single_replica_plan_alone(self) -> None:
        out = planmod.emit_compose(planmod.build_plan(small_cert()))
        self.assertNotIn("command:", out)

    def test_plan_json_round_trips(self) -> None:
        plan = planmod.build_plan(large_cert())
        self.assertEqual(json.loads(planmod.render(plan, "plan")), plan)


class CliTests(unittest.TestCase):
    def _run(self, cert: dict, *args: str) -> tuple[int, Path]:
        tmp = Path(tempfile.mkdtemp())
        cert_path = tmp / "certification.json"
        cert_path.write_text(json.dumps(cert), "utf-8")
        out = tmp / "out.txt"
        try:
            planmod.main([str(cert_path), "--out", str(out), "--quiet", *args])
        except SystemExit as exc:
            return int(exc.code or 0), out
        return 0, out

    def test_certified_cert_writes_a_plan_and_exits_zero(self) -> None:
        code, out = self._run(large_cert())
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.read_text("utf-8"))["replicas"], 4)

    def test_failing_cert_exits_two_and_writes_nothing(self) -> None:
        code, out = self._run(failing_cert())
        self.assertEqual(code, 2)
        self.assertFalse(out.exists())

    def test_predicted_cert_exits_two(self) -> None:
        self.assertEqual(self._run(predicted_cert())[0], 2)

    def test_emit_helm_values(self) -> None:
        code, out = self._run(large_cert(), "--emit", "helm-values")
        self.assertEqual(code, 0)
        self.assertIn("replicaCount:", out.read_text("utf-8"))

    def test_emit_compose(self) -> None:
        code, out = self._run(large_cert(), "--emit", "compose")
        self.assertEqual(code, 0)
        self.assertIn("services:", out.read_text("utf-8"))

    def test_missing_file_exits_one(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            planmod.main(["no-such-cert.json"])
        self.assertEqual(int(ctx.exception.code or 0), 1)


if __name__ == "__main__":
    unittest.main()
