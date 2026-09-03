---
slug: review-doesnt-die-silently
type: perfect/direction
context: "[[voice-creation-studio]]"
lens: robustness
status: shipped
size: M
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: 15cdd5e
---
## What & why
Review isn't polled, so the 30-min idle expiry kills the job under a screen that renders as alive; the user learns at commit-404 and review has NO start-over affordance (stuck until manual reload). streamIngestAsset flattens every asset error to "not found", discarding the service's four distinguished refusal sentences AND Retry-After. cancelCommit swallows its own failure and claims the session is gone while the backend may still be cloning.

## Evidence
- machine.ts:110-112 review not in POLLING_PHASES; ingest_api.py:596-603 idle TTL from touched; page.tsx:330 commit 404 → review, no exit
- backend.ts:199 jsonError("not found", status); ingest_api.py:1275-1295 the four sentences
- page.tsx:342 catch {} + unconditional startOver

## Acceptance criteria
- Review keeps the session alive (lightweight keepalive) OR detects expiry → expired phase; review gains an exit affordance either way.
- Asset errors carry the service's detail + Retry-After to the board/players.
- cancelCommit failure surfaced honestly (the true state named).
- Route tests for touched proxies (ingest proxies currently have zero).

## Risks / non-goals
Keepalive must not defeat GC for abandoned tabs (visibility-gate it). Coordinate with [[studio-polls-and-ships-less]] — same builder, sequenced directions.

## Build record
(pending)
Build record: S-B done. WATCH mode (30s, payload-ignoring) instead of naive POLLING_PHASES add — builder overturned the brief's shape twice correctly (terminal 'done' would stop the hook; JOB_POLLED would wipe ledger edits). streamIngestAsset shape-matches proxyJson; TakePlayer gained onFail + one-shot assetRefusal re-request (an <audio> element never sees a 404 body). cancelCommit failure names the true state + keeps polling. Merged 15cdd5e.
