---
slug: pool-truth-aggregation
type: perfect/direction
context: "[[Concurrency Engine & Metrics]]"
lens: wildcard
status: shipped
size: S
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: da5cd76
---
## What & why
The replica supervisor's aggregated `/metrics` does not aggregate. Under the shipped Linux default (`SO_REUSEPORT`) all replicas share one socket, so the "per-replica" scrape targets are the SAME URL N times and the kernel routes each scrape to an arbitrary replica. The published pool total is therefore N random samples of one pool member — and the load test consumes it as truth and writes it into the certificate's `aggregated_metrics_per_level`. The caveat is documented in the module and then shipped as the default.

## Evidence
- `service/replicas.py:137-143` — `metrics_targets` returns the same URL N times when `reuse_port` is on; `:223` — `reuse_port=True` is the Linux default; `:22-26` documents the caveat.
- `service/replicas.py:159-185` — `totals` sums whatever those N scrapes returned.
- `service/loadtest.py:285-297` — `replicas_launch_command` never passes `--no-reuse-port`; `:315-327` writes the aggregate into the certificate.
- `service/replicas.py:62-65` — `AGG_KEYS` omits `audio_seconds_total`, which is additive and is what the studio's savings ticker reads.

## Acceptance criteria
- The aggregate either reports the real pool (per-replica addressability that survives `SO_REUSEPORT`) or refuses to present itself as a pool total — no number that claims to be something it is not.
- The certificate stops carrying an aggregate it cannot substantiate; if the honest answer is "single-replica sample", it says so.
- `audio_seconds_total` aggregates correctly.
- A test covers the reuse-port aggregation path and asserts the HONEST behaviour (today's test asserts the duplicated-URL behaviour as correct).

## Risks / non-goals
- Do not break the `SO_REUSEPORT` topology itself — it is the right production choice and round 1 deliberately chose it; only the observability of it is wrong.
- Non-goal: a metrics backend, Prometheus exposition, or per-route/per-voice breakdowns.

## Build record
Builder E-B. `metrics_targets` under SO_REUSEPORT now returns ONE target with index None (it used to return the same URL N times). `aggregate_metrics(..., scope=)` publishes either `scope: pool_total` with real sums plus `replicas_reporting`/`replicas_expected`/`complete`, or `scope: single_replica_sample` with `totals: null`, a `sample`, and a note pointing at `--no-reuse-port` — so nothing downstream can sum duplicates by accident. `audio_seconds_total` added to `AGG_KEYS`, and the drift test now walks FLOAT snapshot fields too, with percentiles/ratios explicitly classified non-additive. The certificate gains a `topology` block so a sampled run cannot read as a pool aggregate; sampled counters do NOT fail certification, because client-side latency/throughput was genuinely measured through the shared port across the whole pool.

**Director review**: `test_replicas.py:127` previously asserted the duplicated-URL behaviour as CORRECT — the test encoded the bug — and the builder replaced it deliberately rather than working around it. Verified nothing in web/ reads `totals` (grep: no hits), so the `totals: null` change breaks no shipped consumer. Gates on main: 305 at merge, 341 after the wave. MERGED.

**Operator action**: under the Linux default the launcher's aggregated /metrics now honestly reads `single_replica_sample` with `totals: null`. An external dashboard reading that field must be updated.
