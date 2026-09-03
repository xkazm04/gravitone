---
date: 2026-07-26
slug: honest-fallback-reason
status: in-progress
type: weak-pattern
reach: "2 engine functions / 1 banner / Take + SpeakResult types"
risk: 1
effort: s
payoff: 2
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-async-patterns]]"
---

# engine.ts conflates 5xx with backend-unreachable

## Context
`speak`/`perform` drop to the browser voice for a transport failure AND for any
non-429 error response, then the playground renders one banner for all of them:
"Gravitone backend unreachable — speaking with your browser voice". For a 500
that is false — the backend was reached, synthesis is what failed — and for a
503 during a rolling restart it is misleading (it's coming back). Carried from
the error-handling run's residual gaps; this is the last place in the app that
reports a failure as something it isn't.

## Decision
Keep the fallback (it's deliberate: the playground should always produce
something) and make the *reason* first-class. New `FallbackReason` =
`unreachable | draining | failed`, set at the point where the cause is known,
carried on `SpeakResult` and persisted on `Take`, and mapped to three distinct
strings by `FALLBACK_COPY`. Optional on `Take` so takes restored from
IndexedDB before this field existed still load.

## Consequences
Positive: the last dishonest surface in the playground is gone; a 500 now reads
"Gravitone is reachable but synthesis failed". Negative/risks: three strings to
keep accurate instead of one; the banner reflects the most recent browser take
rather than "any", which is the more useful signal but a behaviour change.
Mitigations: 13 engine tests pin the reason for each cause.

## Rollout
1. FallbackReason + browserFallback helper + copy map + tests — `npm test` (30) and `tsc` green. ✅

## Acceptance criteria
- Transport failure → `unreachable`; 503 → `draining`; other non-ok → `failed`. ✅ tests
- 429 still throws `EngineBusyError` and never falls back. ✅ test
- Success carries no reason. ✅ test

## Regression checklist
- [x] `npm test` 30/30, `tsc` clean.
- [ ] Visual check of the three banner strings — UNVERIFIED (no dev server).
