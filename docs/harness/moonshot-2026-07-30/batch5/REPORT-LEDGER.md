# REPORT — LEDGER (Arm Performance Ledger), Batch 5

> Saved by the orchestrator from the builder's inline report.

**Status: G3 complete.**

Files:
- `service/compare.py` (new): pure diff_results(old,new,tolerance); pairs levels by
  concurrency; refuses cross schema/cache_mode/route/corpus/fpmath and either-side
  measures_synthesis:false with the field NAMED; low_confidence/driver_saturated levels
  reported but excluded from verdict by name; --fail-on-regress N% CLI with certify's 0/2
  exits (refusal and all-excluded ALSO fail — a gate must not pass unproven).
- `service/certify.py`: hw_fingerprint, ledger_row, load_ledger, verify_ledger,
  append_ledger, newest_row, --append-ledger/--ledger-dir/--instance-type. Never rewrites;
  re-derives every row from its artifact and REFUSES on disagreement.
- `docs/certifications/README.md` + empty ledger.json — no fabricated rows.
- `.github/workflows/perf-ledger.yml` — AUTHORED-NOT-RUN banner; PR ramp job
  (ubuntu-24.04-arm) + weekly AWS matrix (t4g advisory-only); weight caching.
- Tests: test_compare.py (35), test_certify.py (+29).

Tests: 100/100 (compare+certify+private_surface); py_compile + YAML parse OK; ASCII.

Side-catch: CLI smoke found a real duplicate-row bug (re-minted certs differ only by
`issued`) — dedupe now keyed on measurement identity.

## Hook (named follow-up, deliberately NOT silently fixed)
`aws/run_benchmark.sh` (unowned this batch) has no `fetch` step — it never copies
`loadtest_result.json` back from the instance, so the matrix job's certify/append step is
inert until it grows one. The workflow FAILS LOUDLY on the missing file rather than
appending an invented row; labelled in-file as FOLLOW-UP.

Deferred (per design): --bisect attribution; web/lib/benchmarks.ts generation (waits for a
real ledger row); third-party signed-cert PR intake.
