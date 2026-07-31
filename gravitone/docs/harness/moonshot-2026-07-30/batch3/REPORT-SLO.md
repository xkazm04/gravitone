# REPORT — SLO (SLO Capacity Contract), Batch 3

> Saved by the orchestrator from the builder's inline report.

**Status: E5 complete (steps 1–4). Step 5 (saturation fit + --probe) DEFERRED.**

Files: `service/workload.py` (new), `service/loadtest.py`, `service/certify.py`,
`service/tests/test_workload.py` (new), `test_loadtest.py`, `test_certify.py`.

- workload: `arrival_schedule` (Poisson, deterministic per seed), `corpus_sample`/
  `corpus_series` — series pairwise-distinct BY CONSTRUCTION (raises rather than repeat a
  body → cache cannot contaminate).
- loadtest: `--arrival poisson --rate R[,R] --duration S --seed --corpus-profile
  --max-in-flight --slo-p95 --slo-violations-max --soak --think-time`. No semaphore;
  AdmissionGate refuses+counts (degrades the level); records offered/achieved/goodput,
  slo_violation_rate, queue_wait_p95 (Little's law over sampled `queued`), peak_in_flight;
  idle-box warning in --help + result JSON + stdout. `level_degraded` gained keyword-only
  SLO args; old rules are the fallback; old tests pass unmodified.
- certify: `sustains_slo` + `capacity_contract{slo, max_rate_rps, soak_minutes,
  concurrent_users}`, CERT_VERSION gravitone-cert/3; predicted-only and failed-soak REFUSED;
  v2 verification (hash + HMAC) still works (tested).

Gates: 144 tests green, py_compile clean. End-to-end ramp→soak→certified verified against a
fake client — no live load. Hooks: none.
