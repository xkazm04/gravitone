---
slug: async-commit-cancel
type: perfect/direction
context: "[[Voice Cloning & Ingest Pipeline]]"
lens: ux
status: shipped
size: M
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 0b6d6c4
---
## What & why
Commit runs synchronously on the request thread — N emotions × ~15s cold loads while the UI shows fabricated timing; no cancel endpoint; expired jobs 404 and the poller spins forever. Make commit a background phase with per-emotion progress in partial, add DELETE /{job} cancel, explicit expired status.
## Evidence
ingest_api.py:171-185; page.tsx:339; ingest_api.py:120-121 + page.tsx:60-68 (404 spinner).
## Acceptance criteria
- commit returns immediately; status polls show per-emotion progress
- cancel aborts between emotions and cleans temp files
- expired jobs return a distinct status the UI can render
- no request thread blocked > 1s
## Risks / non-goals
Coordinate with [[durable-job-lifecycle]] (same job dict) — same builder brief.
## Build record
Wave 1, 2026-07-13. Opus builder; Director-reviewed diff; gates green (compileall + unittest + tsc). Commit 0b6d6c4.
