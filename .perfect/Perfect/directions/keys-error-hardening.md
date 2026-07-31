---
slug: keys-error-hardening
type: perfect/direction
context: "[[Speech Synthesis API]]"
lens: robustness
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: f1aaf21
---
## What & why
validate_key rewrites api_keys.json on every authenticated request with no lock — concurrent requests corrupt the key store; rotate_key silently un-revokes revoked keys; worker exceptions leak verbatim to clients; synthesis timeouts aren't counted in any metric.
## Evidence
keys.py:140-141; keys.py:118; app.py:116; app.py:113 (504 path uncounted).
## Acceptance criteria
- locked + debounced last_used writes
- rotate preserves revoked state
- sanitized client errors (details to server log with request ID)
- timeout counter in /metrics
- regression-tested with mocked engine
## Risks / non-goals
No per-key rate limiting (rejected usage-metering direction); no Prometheus format change.
## Build record
Wave 1, 2026-07-13. Opus builder; Director-reviewed diff; gates green (compileall + unittest + tsc). Commit f1aaf21.
