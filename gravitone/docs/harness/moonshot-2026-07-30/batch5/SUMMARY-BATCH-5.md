# Batch 5 — "Scale & Memory" — SHIPPED

> 5 features, 5 parallel Opus builders + orchestrator integration, 7 commits on
> `vibeman/moonshot-batch-1`. Gates: service 66 modules / 1480 tests / 0 fail
> (batch-4 1288 → +192); web tsc clean, next build PASS, vitest **650/650 fully green**.

## Commits
| Commit | Feature |
|---|---|
| `8130135` | (docs) DESIGN-BATCH-5 |
| `0906e16` | Deadline Contract Engine — cost model, truthful 429s, deadline queue, classes, elastic quality (+app/convai wiring) |
| `5b8fe0b` | Gravitone Fabric — admin/introspect ports, pool_total, least-cost router, drain, /pool |
| `6917fb2` | Arm Performance Ledger — compare.py, append-only signed ledger, perf CI (authored-not-run) |
| `eb6a42e` | Voice Corpus — opt-in durable capture, corpus API + deletion, rederive with provenance |
| `b4e6795` | Re-performable Takes — lineage, direction corpus, review revise rounds, open-in-rack |
| (last) | batch-5 reports + summary |

## Orchestrator integration performed
- DEADLINE Patch A applied to app.py (deadline_s/degrade_allowed request fields,
  promise out-param, truthful _Backpressure/429, X-Gravitone-Deadline/X-Quality-Level) and
  Patch B to convai.py (feature-detected interactive tag).
- FABRIC's `engine.voice_lru_keys()` accessor applied to engine.py after DEADLINE landed.
- REMIX hooks: direction router in app.py; engine.ts uploadTake lineage via sessionStorage.
- serviceHeaders mirror: X-Gravitone-Deadline + X-Quality-Level (drift gate, 4th catch).

## Notable
- LEDGER's smoke caught a real duplicate-row bug (re-minted certs differ only by `issued`)
  — dedupe now keyed on measurement identity.
- CORPUS's rederive deliberately does NOT roll back (rollback would delete the replaced
  original); refusals synchronous, job async.
- FABRIC pinned "service imports stay lazy child-only" with an AST test on top-level imports.
- DEADLINE: `_INTERACTIVE_RESERVE` defaults 0 — the interactive tag changes ordering only,
  never who gets a 429, until an operator opts into a reserve floor.

## Named follow-ups
- `aws/run_benchmark.sh` needs a fetch step before the perf-ledger matrix job can append
  real rows (fails loudly today, never invents data).
- Utterance fan-out across replicas (audio-seam risk) — deferred pending measurement.
- Public re-perform needs the shared per-IP rate limiter (with hero demo).
- Loadtest/certify deadline-hit-rate reporting (DEADLINE step 6).
