---
date: 2026-07-26
slug: silent-failures
status: shipped
type: structural-bug-class
reach: "6 UI sites (auth provider, vault list, mint, rotate, take player, ingest poller)"
risk: 2
effort: s
payoff: 4
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-error-handling]]"
---

# Silent-failure holes that contradict the honesty rule

## Context
Six places where failure had no representation, in a codebase whose comments
cite the honesty rule by name: (1) useAuth's onAuthStateChanged awaited
Firestore with no try/catch — a rules/quota/offline error meant
`setLoading(false)` never ran and the whole app sat on "Loading…" forever
(highest blast radius); (2) MyVoices rendered the "No cloned voices yet" empty
state on a vault read failure; (3) profile mint failed back to an idle button
with zero feedback; (4) KeysLedger rotate was an unhandled promise rejection;
(5) TakeCard rendered an enabled play button that did nothing when audio
failed to load, and the shared useAudioPlayer had no `error` listener (stuck
pause glyph); (6) the ingest poller retried transport errors forever while the
loader animated as if progressing.

## Decision
Per-site minimal fixes, all landing on the shared ErrorBanner / existing error
states: try/catch+finally in the auth callback (degraded null profile, error
surfaced, auth always resolves); vault failure message instead of false empty;
mint error banner; rotate try/catch → ledger banner; TakeCard audioErr state
(disabled button + label) + audio error listener + play() rejection reset;
poller onStalled callback after 3 consecutive failures → degraded-connection
warning banner (retries continue — jobs are durable server-side). Poller also
stops coercing 5xx bodies into Job.

## Consequences
Positive: no invisible failure among the six; the biggest one (forever-Loading)
is structurally impossible now. Negative/risks: auth degraded path signs the
user in with a null profile — pages must tolerate profile==null (they already
do; it was the pre-resolution state). Mitigations: tsc green.

## Rollout
1. All six fixes — tsc green. ✅

## Acceptance criteria / Regression checklist
- [x] tsc --noEmit clean.
- [x] Every fix surfaces through an existing error state or ErrorBanner (no new surface types).
- [ ] Manual walkthrough (block Firestore, kill backend mid-ingest, expired share) — NOT verified locally; flag for a dev-server session.
