---
slug: preview-poll-efficiency
type: perfect/direction
context: "[[Voice Creation Studio]]"
lens: optimization
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: de3ed28
---
## What & why
Preview proxies buffer whole WAVs per request with no cache headers (every replay re-downloads); two pollers tick 1.2-1.5s forever with no backoff; /api/characters refetches on all seven phase transitions; commit proxy carries a vestigial 300s timeout from the sync era.
## Evidence
speaker-preview/route.ts:9, preview/route.ts:9; page.tsx:66, 85; page.tsx:57-61; commit/route.ts:9.
## Acceptance criteria
- preview replays hit cache (no re-download)
- polling backs off during long steps, stops on terminal states
- characters fetched once per visit
- vestigial timeout removed
## Risks / non-goals
No SSE/websocket migration.
## Build record
Round 2 wave 1, 2026-07-13. Opus builder; Director-reviewed; gates green (113 unittests + tsc). de3ed28 (+ef488f6 stale extend-dropdown fix, Director).
