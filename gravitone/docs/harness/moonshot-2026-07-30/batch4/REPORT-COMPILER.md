# REPORT — COMPILER (Deployment Compiler), Batch 4

> Saved by the orchestrator from the builder's inline report.

**Status: F5 complete.**

Files:
- `service/plan.py` (new) — cert v2/v3 → deployment-plan.json; v3 capacity_contract preferred
  (Little's law: rate × p95), v2 cap fallback; named floors/ceilings with every binding clamp
  reported in `notes`; REFUSES failing / predicted-only / cache-contaminated / v1 / malformed
  certs (named reason, exit 2; --verify adds certify's hash/HMAC check); --emit
  helm-values|compose; pure stdlib.
- `service/tests/test_plan.py` (new, 33) — fixtures: t4g.small, c8g.2xlarge, failing,
  predicted-only, v3-contract, 192-core.
- `deploy/gravitone-unit.sh` — gravitone_plan_path (PLAN= override) + gravitone_plan_field;
  env file takes threads/queue from a plan; unit gains optional replicas arg appending
  `python -m service.replicas --replicas N`. Unit text single-sourced; airgap call signature
  unchanged; NO-PLAN OUTPUT BYTE-IDENTICAL to before.
- `deploy/bootstrap.sh` (resolve/report plan, pass replicas), `deploy/README.md`
  (measure→plan→deploy + autoscaling table + roles), `values.yaml` (generator pointer +
  KEDA/SO_REUSEPORT caveat at the point of choice), `helm/gravitone/README.md`,
  `docs/SUPPORTED_HARDWARE.md` (Plan column; states no plans exist yet for the measured rows
  — none fabricated).

Tests: test_plan + test_certify + test_private_surface = 76 pass; py_compile clean; bash -n
clean on all deploy shells. Hooks: none.
