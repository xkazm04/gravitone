---
date: 2026-07-26
slug: error-taxonomy
status: shipped
type: weak-pattern
reach: "~44 raise sites / 10 files / 5 body shapes / 2 schemas for one 404"
risk: 3
effort: m
payoff: 3
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-error-handling]]"
---

# Service has no error taxonomy module

## Context
Five error-body shapes, no catch-all handler (unhandled exceptions escaped to
Starlette's plain-text page, breaking the `{"detail"}` contract), two 404
schemas for "job not found" in the same file (`ingest_api.py:327` vs `:336`),
and opposite leak postures: `app.py:185` sanitizes worker errors behind a
request id while `voices.py:585` handed clients 400 bytes of ffmpeg stderr.

## Decision
Scoped consolidation, not a rewrite: new `service/errors.py` owning
`sanitized_500()` (request-id pattern, generalized from app.py),
`job_expired()` (the ONE canonical `{"status": "expired", "detail"}` 404),
`tail()` truncation, and `install_catch_all(app)`. Convert the known offenders;
leave per-router HTTPException style alone (cosmetic, tests pin it).

## Consequences
Positive: the JSON contract has no hole; one place to grow the taxonomy; clone
500 no longer leaks stderr; pollers get one schema.
Negative/risks: catch-all changes unhandled-error bodies (plain text → JSON) —
strictly closer to the documented contract; clients parsing the old plain text
would notice (none do — web proxies passthrough).
Mitigations: Starlette still re-raises after the handler, so server-side
tracebacks/logging behavior is unchanged.

## Rollout
1. `service/errors.py` + wire into app.py, ingest_api.py, voices.py — compileall + suite. ✅
2. Contract tests: catch-all JSON shape; all 6 job routes return canonical expired shape. ✅ (168 tests OK)

## Acceptance criteria
- Unhandled route exception → JSON `{"detail": "internal error (request <id>)"}`, raw cause logged. ✅ test
- All job-not-found responses identical across the 6 ingest routes. ✅ test
- Clone failure detail carries no stderr. ✅ (sanitized_500 path)

## Regression checklist
- [x] Full suite at baseline+: 168 OK (baseline 164, +2 F5, +2 this).
- [x] Synthesis sanitized-500 phrasing unchanged — existing test still green.
