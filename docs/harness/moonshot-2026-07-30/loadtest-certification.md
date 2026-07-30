# Moonshots — Load Testing, Benchmarks & Certification (2026-07-30)

Context files read: `service/loadtest.py`, `service/certify.py`, `benchmark_arm.sh`,
`benchmark_arm_ab.sh`, `benchmark_t4g.sh`, `aws/run_benchmark.sh`,
`docs/SUPPORTED_HARDWARE.md`, `web/lib/benchmarks.ts`, `web/app/benchmarks/*`,
`service/tests/` inventory, `docs/harness/followups-2026-07-10.md`.

Two structural facts drive both proposals:

1. **The harness is closed-loop.** `run_level()` fires a fixed `n_requests`
   behind an `asyncio.Semaphore(concurrency)` — a new request only starts when a
   previous one finishes. That measures *how many simultaneous streams a box
   tolerates*; it structurally cannot measure *how many real users with real
   arrival patterns a box serves at a latency SLO*, because closed-loop load
   self-throttles the moment the server slows. There is also no soak dimension
   (levels are seconds long), and the corpus is one constant sentence.
2. **Certification is a one-shot artifact with no memory.** `certify.py` mints a
   hashed cert from a single result JSON; there is no `docs/certifications/`
   directory, no `.github/` at all, no comparison primitive, and
   `web/lib/benchmarks.ts` hard-codes numbers *transcribed from README by hand*.
   Meanwhile `benchmark_arm_ab.sh` already isolates every Arm knob and
   `aws/run_benchmark.sh` already launches → benches → terminates a Graviton by
   instance type over SSM. Everything needed for a continuous, machine-fed
   performance record exists as loose parts and is wired to nothing.

---

## M1. The Arm Performance Ledger — every commit, every Arm microarchitecture, continuously re-proven

- **Tier**: 1 (10x category-defining)
- **Category**: platform
- **Impact**: Turns "Gravitone is realtime CPU TTS on Arm" from a hand-transcribed
  README table into an append-only, signed, machine-generated time series that
  gates merges and publishes itself — so the performance claim can never quietly
  rot, and every regression is attributed to a commit, torch version and fpmath
  mode on named silicon.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: No open TTS project can say "here is what this model did
  on Neoverse N1/N2/V2 at every commit for the last year, each row reproducible
  and integrity-signed." That ledger *is* the moat: it makes Gravitone the
  reference measurement authority for CPU speech on Arm, which is a platform
  position, not a feature. It also inverts the economics of trust — buyers stop
  believing our numbers and start reading our history.
- **Path to implementation**:
  1. **Today, in-scaffold:** add `service/compare.py` — a pure, unit-testable
     `diff_results(old, new, tolerance)` that pairs levels by `concurrency` and
     reports deltas on `server_rtf_mean`, `audio_s_per_wall_s`, `lat_p95_s`,
     `recommended_cap`, refusing to compare across `schema_version`,
     `cache_mode`, `route`, `corpus` or `onednn_fpmath_mode` mismatch (the
     result JSON already carries all of these — `build_result`/`runtime_metadata`
     did the hard part). Mirror the existing honesty discipline: a diff whose
     either side has `measures_synthesis: false` returns `comparable: false`.
     Add `service/tests/test_compare.py` next to `test_loadtest.py`.
  2. Define the ledger: `docs/certifications/<hw-fingerprint>/<git_sha>.json`
     (the raw cert) plus a single append-only `docs/certifications/ledger.json`
     index whose rows are `{hw_fingerprint, cpu_model, cores, git_sha, issued,
     torch_version, fpmath, single_stream_rtf, cap, aud_s_at_cap, verdict,
     sha256}`. Fingerprint = stable hash of `gather_hardware()` + instance type.
     Extend `certify.py` with `--append-ledger` (verify → then append; never
     rewrite history).
  3. Add `.github/workflows/perf-ledger.yml` (the repo has no CI at all yet) with
     two jobs: a cheap `ubuntu-24.04-arm` job that runs the short ramp on every
     PR, and a scheduled/dispatch matrix job that drives the *existing*
     `aws/run_benchmark.sh` over `TYPE ∈ {t4g.small, c8g.2xlarge, m8g.xlarge}`
     — that script already does up → bench → fetch → terminate.
  4. Wire the gate: PR job pulls the newest ledger row for its hardware class,
     runs `service/compare.py`, and fails on a regression beyond tolerance
     (`--fail-on-regress 5%` on RTF or cap). Same exit-code ergonomics
     `certify.py` already uses (0/2).
  5. Add commit attribution: on a gate failure, a `--bisect` mode re-runs the
     single-stream A/B (`benchmark_arm_ab.sh` variants, already one-knob-isolated)
     to report *which* knob or dependency moved, and writes the finding into the
     ledger row as `regression_attribution`.
  6. Replace the hard-coded `web/lib/benchmarks.ts` dataset with a generated
     module built from `ledger.json` at build time, and extend `/benchmarks`
     with a per-microarchitecture trend view. Then — and only as a small add-on —
     accept opt-in third-party rows: a signed cert (HMAC via
     `verify_certificate`) submitted as a PR is auto-validated by the workflow
     and appended, so `docs/SUPPORTED_HARDWARE.md` becomes generated rather than
     hand-edited. (Deliberately *not* the deferred "results-upload endpoint +
     moderation" idea: no server, no moderation queue — the ledger is
     git-native and the CI is the moderator.)
- **Dependencies**: an Arm64 CI runner (GitHub's `ubuntu-24.04-arm` hosted
  runners, or self-hosted on the certified box); an AWS account/profile with
  `aws/iam-policy.json` for the matrix job (the followups note no profile exists
  on the dev machine yet); `GRAVITONE_CERT_SECRET` as a repo secret; model-weight
  caching in CI or every run pays the download.
- **Risks**: cloud-run cost and flakiness of the matrix job (mitigate: ramp only,
  low `REQS`, scheduled not per-PR); noisy-neighbour variance on shared/burstable
  instances producing false regressions (mitigate: tolerance bands per hardware
  class, `low_confidence`/`driver_saturated` rows excluded from the gate, and
  t4g's CPU credits make it advisory-only); ledger churn bloating the repo
  (mitigate: index row per run, full cert only for verdict changes).
- **What changes if we ship it**: Performance becomes a tracked, gated,
  publishable property of the project rather than a claim someone measured once
  — and the supported-hardware matrix grows itself instead of waiting on manual
  PRs.

---

## M2. SLO Capacity Contract — answer "how many users can this box serve", not "what concurrency breaks it"

- **Tier**: 1 (10x category-defining)
- **Category**: functionality
- **Impact**: Replaces the closed-loop concurrency knee with an open-loop,
  arrival-driven capacity statement — "this box sustains 7.4 req/s of *your*
  traffic shape at p95 ≤ 2.0s for 30 minutes, ≈ 210 concurrent listeners" —
  and makes that the thing the certificate certifies and the planner plans.
- **Feasibility**: high
- **Time-horizon**: weeks → months
- **Why it's a moonshot**: Every self-host capacity tool in this space ships a
  closed-loop `ab`-style ramp, which is a measurement of the *load generator*
  as much as the server: when the server slows, the harness politely sends less
  work, so queueing — the actual failure mode in production — never appears. Going
  open-loop with a real arrival process, a real corpus distribution, and a
  declared SLO converts the benchmark from a lab curiosity into a contract an
  operator can hold us to. Fitting a saturation curve on top means one measured
  ramp *predicts* untested replica counts and request rates, so sizing stops
  requiring the hardware you haven't bought yet.
- **Path to implementation**:
  1. **Today, in-scaffold:** add `service/workload.py` with two pure functions in
     the style `loadtest.py` already favours (pure core, unit-tested without a
     server): `arrival_schedule(rate_rps, duration_s, seed) -> [offsets]`
     (exponential inter-arrivals, deterministic per seed) and
     `corpus_sample(profile, seed) -> text` drawing from a length distribution
     (short/typical/long-form buckets) instead of the single `TEXT_DEFAULT`
     constant. Add `service/tests/test_workload.py` asserting mean rate,
     determinism, and that varied corpora defeat the synthesis cache by
     construction (a second honesty guarantee alongside `--cache-mode bypass`).
  2. Add an open-loop driver to `loadtest.py`: `--arrival poisson --rate R
     --duration S`, which schedules requests on wall-clock offsets and fires them
     regardless of in-flight count (no admission semaphore). Reuse `_one`/
     `_one_stream` and the existing `_sample_resources` CPU split verbatim.
     Record per-level `offered_rate`, `goodput_req_s`, `queue_wait_p95`
     (from the `/metrics` `queued` delta already scraped by `run_ramp`), and
     `slo_violation_rate`.
  3. Generalise degradation into an SLO predicate: extend `level_degraded()`
     (already pure and unit-tested) with `--slo-p95 2.0 --slo-violations-max 1%`
     so the "knee" becomes *the highest offered rate meeting the SLO* — keeping
     the current p95-factor/CPU-ceiling rules as fallbacks when no SLO is given.
     Add a `--soak <minutes>` at that rate to catch thermal throttling, memory
     growth and burstable-credit exhaustion (exactly what `benchmark_t4g.sh`
     tiptoes around today).
  4. Extend `certify.py` with a fourth check and a new capacity block:
     `sustains_slo` → `{slo, max_rate_rps, soak_minutes, concurrent_users}`
     where users = rate × session think-time. Bump `CERT_VERSION` to
     `gravitone-cert/3` (the file already sets the precedent that a changed
     measurement basis demands a new version, never a silent behaviour change).
  5. Fit and extrapolate: from the ramp's rate/latency pairs, fit a
     utilization-vs-latency saturation curve per replica count and emit
     `predicted_rate_at_replicas` with a residual-based confidence band; then
     add `--probe`, a ~90-second single-stream + two-point run that yields a
     *predicted* capacity envelope, with the full ramp reserved for validating
     the prediction. Publish the residual so the prediction is falsifiable.
  6. Feed both into the web planner: `/benchmarks` gains a "describe your
     traffic" input (calls/hour, script length mix, streaming vs batch) and
     returns replica count + the exact `service.replicas` command, driven by the
     fitted model rather than the hand-transcribed `BENCHMARKS` table.
- **Dependencies**: `service/replicas` + `/metrics` scrape (both already wired);
  a small representative corpus in-repo (script snippets, no PII); a real Arm
  Linux box for any multi-replica soak (the non-Linux fallback in
  `run_replicas_mode` only ever hits replica 0); off-box load generation for high
  rates or `driver_saturated` will fire (the harness already detects this).
- **Risks**: open-loop runs can genuinely melt a small box — needs a hard
  `--max-in-flight` circuit breaker and a documented "run on an idle box"
  warning; longer soaks make CI expensive (mitigate: short soak in the M1 PR
  gate, long soak scheduled); the fitted extrapolation could be believed too
  literally (mitigate: confidence band + refuse to certify predicted-only
  numbers, mirroring how `measures_synthesis` refuses cache-contaminated runs);
  cert version bump invalidates comparison against v2 certs by design.
- **What changes if we ship it**: The certificate stops describing a lab ramp and
  starts describing a promise to end users — which is the only capacity number an
  operator, an SRE, or a procurement reviewer actually cares about.
