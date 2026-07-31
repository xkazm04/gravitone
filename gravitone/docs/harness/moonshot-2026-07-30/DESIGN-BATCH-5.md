# Batch 5 Design — "Scale & Memory"

> Five features, one story: **the box gets bigger and remembers.** The engine promises
> latencies and keeps them (Deadline Contract Engine), N replicas become one addressable
> machine (Gravitone Fabric), performance history becomes an append-only signed ledger
> with the repo's first perf CI (Arm Performance Ledger), everything ingest learns
> survives the job (Voice Corpus), and shared takes become fork points whose edits feed a
> direction corpus (Re-performable Takes).
>
> Branch: `vibeman/moonshot-batch-1` (continues). Builders NEVER run git. All prior batch
> vocabulary binding. ⚠ No Arm CI runner / AWS profile / real load on this box — CI and
> live-run surfaces are AUTHORED and unit-tested, never executed.

## 1. Shared contracts

### G1. Cost & deadline (service, owned by DEADLINE)
`Metrics.cost_estimate(text_len, max_tokens) -> {est_synth_s, basis: warm|cold|insufficient}`
from existing windows (promise ONLY from a warm window; widen by measured p95/p50 spread).
`Job` gains `deadline_s: float | None` (None = exact FIFO-equivalent behaviour — pinned
byte-identical) + `est_synth_s`. 429 body gains `retry_after_s` + `predicted_wait_s`;
accepted requests get `X-Gravitone-Deadline` promise + `X-Quality-Level` when elastic
quality reduced decode steps (visible, never silent). Two admission classes:
`interactive` (convai) with a reserved permit floor, `bulk` default — with an aging term so
bulk never starves. app.py threading of the `deadline` request field is delivered as an
exact patch in the report (app.py is NOT owned this batch — orchestrator applies).

### G2. Fabric introspection & router (service, owned by FABRIC)
Per-replica internal admin port (always sequential, even in SO_REUSEPORT mode) serving
/metrics + NEW `/introspect` {live_workers, available_permits, queue_depth, voice_lru_keys}
— INTERNAL ONLY (bind 127.0.0.1). `aggregate_metrics` gains true `pool_total` scope in all
modes. Optional stdlib front-door router (thin, opt-in flag, direct mode stays default):
least-cost pick by (free permits, queue depth, voice-affinity). Drain-based replacement
(stop routing → in_flight==0 → replace). Fan-out of one utterance is DEFERRED (audio-seam
risk needs measurement). replicas.py stays stdlib-only (never imports torch) — conformance
with its existing AGG_KEYS contract tests.

### G3. Ledger (service+CI, owned by LEDGER)
`service/compare.py::diff_results(old, new, tolerance)` — pure; pairs levels by concurrency;
refuses cross-schema/cache-mode/route/corpus/fpmath comparisons (`comparable: false`, named
reason); honors `measures_synthesis: false`. Ledger layout:
`docs/certifications/<hw-fingerprint>/<git_sha>.json` + append-only
`docs/certifications/ledger.json` (row schema per proposal). `certify.py --append-ledger`
(verify → append; NEVER rewrite history — extend certify, don't fork it).
`.github/workflows/perf-ledger.yml` AUTHORED (PR ramp job on ubuntu-24.04-arm + scheduled
aws matrix via existing run_benchmark.sh) — labelled authored-not-run. web/lib/benchmarks.ts
generation from ledger.json is DEFERRED until a real ledger row exists (do not generate from
fabricated data).

### G4. Corpus (service, owned by CORPUS)
On successful commit, COPY (never move) durable facts into `SETTINGS.corpus_dir/<character_id>/`:
used segment wavs, segments.json (labels/confidences/cues/failures), stems, Levels,
clip_sha256, consent ref. Append-only, content-addressed by clip hash (re-ingest = no-op).
`corpus.json` index per character; `GET /v1/characters/{id}/corpus` (what audio the box
holds) + `DELETE .../corpus/{clip_sha}` (removes every derived segment — the retention
story). `POST /v1/ingest/rederive {character_id, emotions?}` rebuilds stems from corpus
best-of (fidelity when present, duration×confidence otherwise) and re-exports via the
existing child path. OPT-IN per character (`corpus: true` on the ingest request; default
OFF — sovereignty first), visible, itemized, deletable; hard byte cap + named pruning.
Provenance `derived_from {corpus_rev, dsp_version, model_version}` stamped on re-derived
Voices. GC keeps reaping workdirs — corpus is purely additive.

### G5. Lineage & direction (service+web, owned by REMIX)
takes.py: optional `parent_id` + `derived_from` on create_take (validated like
character_id); `GET /v1/takes/{id}/lineage` (bounded depth); lineage-aware eviction
(_evict_oldest must not orphan a chain — evict leaf-first). `service/direction.py`
(demand.py's lock + atomic_write_text discipline): record_delta(parent, child) counts
(character_id, from_emotion → to_emotion); never raises. Web: "open this take in the rack"
on /t/[id] + the takes log (playground pre-loaded via existing deep-link/composer seams —
owner-only re-render; NO public compute this batch). Review revise: a reviewer's requested
change seeds a NEW review round from the picked take (preserves first-pick-final).
Public re-perform + rate limiter = DEFERRED (shared limiter with hero demo is its own pass).

## 2. File ownership (HARD)

| Agent | Owns | Must NOT touch |
|---|---|---|
| **DEADLINE** | `service/engine.py`, its tests | `service/app.py` (patch in report), `service/convai.py` (tag patch in report), `service/replicas.py`, web/** |
| **FABRIC** | `service/replicas.py`, its tests | `service/engine.py` (read-only; needs accessors → report hook), `service/app.py`, web/** |
| **LEDGER** | `service/compare.py` (new), `service/certify.py` (--append-ledger only), `.github/workflows/perf-ledger.yml`, `docs/certifications/**` (layout + README, no fabricated rows), their tests | `service/loadtest.py`, `service/plan.py`, web/** |
| **CORPUS** | `service/ingest.py`, `service/ingest_api.py`, `service/config.py` (corpus settings), their tests | `service/voices.py`, `service/export_stems.py` (read-only; hooks → report), web/** |
| **REMIX** | `service/takes.py`, `service/direction.py` (new), their tests, `web/app/t/[id]/**`, `web/app/r/[id]/**`, `web/lib/takes.ts` | `web/app/playground/**` (deep-link seam only → if a change is needed, report it), service/demand.py, web/** elsewhere |

engine.py single owner: DEADLINE. FABRIC reads engine's public surface; any needed accessor
(e.g. voice-LRU keys) is an exact patch in FABRIC's report, applied by the orchestrator
after DEADLINE lands.

## 3. Gates
Service: your modules + `test_private_surface`, `test_admission_accounting`, `test_abandon`,
`test_worker_supervision`, `test_replicas` (FABRIC + DEADLINE both), `test_ingest_truth` +
all `test_ingest_*` (CORPUS), `test_takes_reviews` (REMIX), `test_certify` (LEDGER) — green;
py_compile; bash -n where relevant. Web (REMIX): tsc + full vitest green except the tracked
flake. NO git. ASCII. No live load, no AWS, no image builds.

## 4. Reports
Reply <150 words + exact hook patches (DEADLINE: app.py deadline threading + convai
interactive tag; FABRIC: engine.py accessors). Orchestrator persists under `batch5/`.
