---
slug: build-joins-the-pool
type: perfect/direction
context: "[[concurrency-engine-metrics]]"
lens: optimization
status: shipped
size: M
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: e167a57
---
## What & why
`/v1/build` — the route made for 300-line scripts — is the only synthesis path rendering strictly sequentially (one awaited line at a time), while `/v1/speak`/`/v1/performance` got `_submit_and_gather_in_waves` precisely to avoid this; app.py:436 states the principle build violates. Plus: `get_build_zip` makes one executor round-trip PER LINE (300 hops before the first byte) and `_voice_fingerprint` stats the filesystem on the event loop per digest.

## Evidence
- app.py:1950-1973 sequential render; :423-458 the waves helper; :436 the principle
- app.py:2044-2049 per-line _offload; :538-554 loop-side Path.stat per digest; :1127-1150 per-request version string rebuilds

## Acceptance criteria
- Build renders through the same wave-submission path as speak/performance (one answer to "units per request").
- Byte-identity/determinism of builds preserved and PROVEN by test (the route's whole point) — parallel render must not reorder or change bytes.
- Zip assembly batches its I/O in one offload; fingerprint/version work cached or off-loop.
- Measured or test-asserted: N-line build no longer O(N) awaited round-trips.

## Risks / non-goals
- Cache keys (`_speech_digest`) must not change — no invalidation of existing stores.
- Non-goal: unifying the three content stores (separate future direction).

## Build record
(pending)
