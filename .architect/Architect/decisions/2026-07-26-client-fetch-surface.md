---
date: 2026-07-26
slug: client-fetch-surface
status: shipped
type: convention-gap
reach: "4 throwDetail reimplementations → 1 / 12 hand-rolled banners → 1 component"
risk: 2
effort: m
payoff: 3
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-error-handling]]"
---

# No shared client fetch helper or error-surface convention

## Context
"Turn a non-OK response into a message" existed four ways (characters.ts
throwDetail, keys/data.ts inline, ingest page, engine.ts) with different
json-parse ordering — the unguarded variants surfaced raw SyntaxErrors. Amber
and rose each meant both "error" and "warning" depending on the file; seven
distinct error-display mechanisms existed.

## Decision
- `lib/apiFetch.ts`: ApiError (status preserved), readDetail (defensive parse),
  throwDetail (503 → "Gravitone backend unreachable"), apiJson. Migrated
  characters.ts, keys/data.ts, and the ingest page's two unguarded r.json()
  sites. engine.ts deliberately NOT migrated — it is the one typed-error path
  (EngineBusyError + browser fallback semantics); folding it in would risk the
  429 flow for a cosmetic win.
- `components/ui/ErrorBanner.tsx`: severity prop — error → rose, warning →
  amber. Swapped the 8 error-meaning banners (5 were amber); genuine warnings
  (playground fallback notice, vault warning, label_errors chip) stay amber.
- keys rotate now surfaces the backend detail ("cannot rotate a revoked key")
  instead of a blanket "rotate failed".

## Consequences
Positive: one place to evolve message rules; severity readable from color;
status survives on thrown errors for future 429 branching. Negative/risks:
banner visual weight changed slightly at 8 call sites (px-4/py-2/text-[11px]
normalized); toast/pip/auto-clear surfaces intentionally left for a future
pass — this decision unifies the *inline banner* tier only.
Mitigations: component matches the app's existing font/rounding idiom.

## Rollout
1. lib/apiFetch.ts + ErrorBanner + migrations — tsc green. ✅

## Acceptance criteria / Regression checklist
- [x] tsc --noEmit clean.
- [x] No remaining `border-amber-400/25` banner whose content is an error message.
- [ ] Visual pass over the 8 swapped banners — NOT verified (no dev-server session); flag for next UI session.
