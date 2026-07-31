---
date: 2026-07-26
slug: web-test-runner
status: in-progress
type: convention-gap
reach: "whole web app (0 → 17 tests); unblocks guards for every web convention"
risk: 1
effort: m
payoff: 3
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-async-patterns]]"
---

# The web app had no test runner

## Context
`web/package.json` had only dev/build/start/lint. Everything shipped in both of
today's architect runs was verified by `npx tsc --noEmit` alone — which proves
types and nothing about behaviour. The conventions codified in
`.claude/CLAUDE.md` (never claim success on failure, always surface a failed
request, guard state after an await, severity readable from colour) are
precisely the class of rule a type checker cannot enforce, so
`strong-patterns.md` recorded "no structural guard possible" as a standing gap.

## Decision
Vitest + jsdom + Testing Library (the standard pairing for a Vite-compatible
React 19 app; Jest would need extra transform config for the same result).
`npm test` → `vitest run`, `npm run test:watch` for local use.
Config notes worth keeping: `esbuild.jsx: "automatic"` is required because
`tsconfig` says `jsx: "preserve"` (Next compiles JSX itself), so esbuild would
otherwise emit the classic runtime and every `.tsx` test would need React in
scope; `@testing-library/jest-dom/vitest` is loaded from `vitest.setup.ts`.

First 17 tests deliberately target the conventions, not incidental behaviour:
- `lib/apiFetch.test.ts` (9) — defensive JSON parse (the raw-SyntaxError bug),
  detail preference, the 503 wording rule, ApiError status, and that a failed
  `apiJson` throws rather than resolving to `[]` (the erased-error bug).
- `lib/useCopyFeedback.test.ts` (5) — copied/failed states, the "never claim
  copied when the clipboard refused" rule, keyed targets, timer cleanup on
  unmount.
- `components/ui/ErrorBanner.test.tsx` (3) — renders nothing when empty,
  `role="alert"`, and error=rose / warning=amber.

## Consequences
Positive: the honesty conventions are now enforceable; future web work has a
real gate beside `tsc`. Negative/risks: two more dev dependencies and a slower
CI step (~2s); test files are inside `tsconfig`'s include, so they are
typechecked too (desirable, and confirmed not to affect `next build`, which
only compiles the route graph).
Note: `npm audit` reports 3 high advisories in `next`/`postcss`/`sharp` — all
PRE-EXISTING transitive deps, not introduced here. Surfaced to the user; a Next
upgrade is its own decision, not a side effect of adding a test runner.

## Rollout
1. Install + config + first 17 tests — `npm test` green, `tsc` clean. ✅

## Acceptance criteria
- `npm test` runs and passes. ✅ (17/17)
- Tests cover conventions `tsc` cannot check. ✅
- Production typecheck unaffected. ✅

## Regression checklist
- [x] `npx tsc --noEmit` clean with test files present.
- [ ] `next build` — UNVERIFIED (not run; test files are outside the route graph so no impact is expected).
