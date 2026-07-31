---
date: 2026-07-26
slug: web-async-hygiene
status: in-progress
type: convention-gap
reach: "3 new hooks / 4 unguarded refreshes / 9 leaky timers / 2 duplicate pollers / 2 impure updaters / 2 error-erasing fetches"
risk: 2
effort: m
payoff: 3
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-async-patterns]]"
---

# Web async hygiene: good idioms, ~40% coverage

## Context
The codebase knows the right patterns and documents them — it just applies
them unevenly:
- Post-await guards exist in three spellings (`alive`/`cancelled`/`stopped`)
  and **every data-hook `refresh()` skipped them** (useCharacters, useCharacter,
  useKeys, MyVoices), so navigating away mid-fetch updated a dead hook.
- Nine copy-toast `setTimeout`s with no ref and no unmount clear; exactly one
  correct implementation existed (`characters.ts:320`).
- `/api/health` polled by two hand-rolled 30s intervals (BenchmarksView,
  SavingsTicker) — the drift the ingest state machine's header explicitly warns
  about.
- Two `setSeconds(s => { … recRef.current?.stop(); … })` side effects inside
  state updaters (GuidedRecorder, HeroMicDemo): updaters must be pure and
  React 19 StrictMode double-invokes them, so the auto-stop could fire twice.
- `/api/characters` fetched four ways, two of them erasing errors into `[]`
  (PlaygroundConsole, the ingest page) — bypassing `lib/apiFetch` from earlier
  today.
- The ingest page carried the tree's only `exhaustive-deps` suppression, with a
  boolean expression as a dependency.

## Decision
Three shared hooks, then migrate:
- `lib/useMounted.ts` — one name for the guard; adopted in all four refreshes.
- `lib/useCopyFeedback.ts` — timer in a ref, cleared before re-arm and on
  unmount, plus a `failed` state so a denied clipboard stops rendering
  "✓ copied" (the honesty rule applied to a 1.5s label). All nine sites moved;
  `reset()` covers the two that clear the indicator on context change.
- `lib/useHealthPoll.ts` — one poller, alive-flagged, exposing `stale` so a
  consumer can mark old numbers instead of rendering them as live.
Plus: both recorders compute elapsed outside the updater; PlaygroundConsole and
the ingest page route the roster through `apiJson` (the playground now shows a
banner instead of an empty rail); the deps suppression is replaced with real
boolean deps.

## Consequences
Positive: one idiom per concern; no setState-after-unmount in the data layer;
no leaked timers; copy labels stop lying; roster failures visible.
Negative/risks: `useHealthPoll` changes SavingsTicker's shape slightly (reads
`health.metrics` rather than its own state) — same rendering condition;
`useCopyFeedback` is generic over a key type, so multi-target copy sites
(profile, TakeCard) pass a discriminator.
Mitigations: tsc clean; every migration is behavior-preserving on the success
path and only adds signal on the failure path.

## Rollout
1. Three hooks + all migrations — `npx tsc --noEmit` clean. ✅

## Acceptance criteria
- Zero `setTimeout(() => setCopied…)` left in the tree. ✅ (grep: 0)
- All four data-hook refreshes guard on `mounted`. ✅
- One `/api/health` poller. ✅
- No side effects inside state updaters. ✅
- No error-erasing roster fetch. ✅

## Regression checklist
- [x] tsc clean.
- [ ] Visual/interaction pass over copy buttons, benchmarks strip, savings ticker — UNVERIFIED (no dev-server session).
