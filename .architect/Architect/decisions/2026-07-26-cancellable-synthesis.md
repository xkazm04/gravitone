---
date: 2026-07-26
slug: cancellable-synthesis
status: in-progress
type: convention-gap
reach: "2 engine functions + the playground generate control"
risk: 1
effort: s
payoff: 2
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-async-patterns]]"
---

# No client-side cancel for a long synthesis

## Context
The scan found **zero** `AbortController`s in client code. `HeroMicDemo` added
one for this same backend with the rationale "a stalled CPU backend can hold
the demo ~5 min otherwise" — but the playground, where users generate
repeatedly and scripts are far longer, had no cancel at all: only wait or
reload. Server-side this now matters more, not less: `_await_result` gained a
`CancelledError` arm this session, so a client that actually disconnects frees
the worker slot instead of burning a full generation.

## Decision
`speak`/`perform` take an optional `AbortSignal` (added with the fallback-reason
work, tested there) and re-throw aborts rather than fabricating a browser take —
a user cancel is not a backend failure. The playground keeps the in-flight
controller in a ref, shows a `cancel` button beside Generate while busy, and
aborts on unmount so navigating away doesn't leave a request holding a slot.
Both catch blocks treat an abort as a no-op: no toast, no take.

## Consequences
Positive: a stalled render is escapable; cancelling now actually releases the
server-side worker (the two halves of this fix meet). Negative/risks: an
aborted run leaves no trace in the UI — deliberate, since the user initiated
it. Mitigations: abort detection is centralized in `isAbort` (jsdom and node
disagree on the exception shape) and unit-tested.

## Rollout
1. signal params + isAbort + tests (shipped with the fallback-reason commit). ✅
2. Playground controller ref, cancel button, unmount abort — `npm test` 30/30, `tsc` clean. ✅

## Acceptance criteria
- An abort propagates instead of producing a browser take. ✅ test
- The signal reaches `fetch`. ✅ test
- A cancel produces no toast and no take. ✅ (both catch arms)
- Unmount aborts an in-flight run. ✅

## Regression checklist
- [x] `npm test` 30/30, `tsc` clean.
- [ ] Click-cancel against a real slow render — UNVERIFIED (no runtime/dev server).
