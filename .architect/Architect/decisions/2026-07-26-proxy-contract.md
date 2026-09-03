---
date: 2026-07-26
slug: proxy-contract
status: shipped
type: weak-pattern
reach: "26 route files / ~20 hand-rolled fetch blocks / 5 error dialects → 1"
risk: 2
effort: m
payoff: 4
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-error-handling]]"
---

# Proxy layer fragments the service error contract

## Context
`lib/backend.ts` was extracted mid-refactor (proxyWavPost, streamIngestAsset)
but the JSON path was never pulled in: 20/26 routes hand-rolled try/fetch/catch
in five dialects. Concrete defects: `/api/tts` flattened 429+Retry-After into
plain-text 502; `reviews/preferred` swallowed backend-down into a 200 fake-empty;
plain-text 503s hit unguarded `r.json()` (user-visible SyntaxError in the commit
flow); DELETE routes dropped 409 detail bodies; timeouts existed on 12/26 routes
with 7 ad-hoc values, and the ingest *poller* had none.

## Decision
New `proxyJson()` in lib/backend.ts: status+body passthrough, Retry-After
preserved, one JSON unreachable shape, timeout on every call (READ 15s / WRITE
30s defaults, explicit budget for slow paths: clone 300s, scan/import 120s,
takes 60s). Migrated all JSON routes; binary routes (pack, take audio, wav,
ingest assets) keep bespoke streaming but now share jsonError + timeouts.
`health` keeps its deliberate `{status: "unreachable"}` probe shape.
`reviews/preferred` now 503s honestly (consumer already branches on r.ok).

## Consequences
Positive: 429 busy-vs-broken survives everywhere; JSON contract end-to-end;
error details reach the UI; every proxy call bounded.
Negative/risks: clients that pattern-matched old plain-text bodies would break —
grep found none (all check r.ok or parse JSON defensively); /api/tts callers
now see real statuses instead of uniform 502 (they treat any non-ok as
fallback, so behavior-compatible). Mutations gained a 30s default timeout —
generous for metadata ops; slow paths carry explicit budgets.
Mitigations: tsc green; per-route review of consumers during migration.

## Rollout
1. proxyJson + jsonError sweep in lib/backend.ts — tsc. ✅
2. Migrate 20 routes + tts passthrough + preferred honest-503 — tsc green. ✅

## Acceptance criteria / Regression checklist
- [x] tsc --noEmit clean.
- [x] No route returns plain text on any path (except health's documented probe shape).
- [x] 429 + Retry-After survive /api/tts, /api/speak, /api/performance.
- [ ] Live smoke against a running backend — NOT verified (no local TTS runtime); flagged for the next session with the service up.
