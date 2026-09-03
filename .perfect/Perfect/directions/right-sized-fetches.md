---
slug: right-sized-fetches
type: perfect/direction
context: "[[Character & Voice Management]]"
lens: optimization
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: d0e58be
---
## What & why
Detail page downloads the ENTIRE roster to show one character (useCharacterVoices.ts:26-38) while single-character + manifest endpoints sit unused; every mutation full-roster refetches; bulk tag/delete run N serial round-trips (CharacterTable.tsx:86-94). Single-character fetch on detail, parallel bulk ops + one refresh, targeted refetches.
## Acceptance criteria
- detail page fetches one character (not the roster)
- bulk ops parallel + single refresh
- mutation refetches targeted
- behavior identical
## Risks / non-goals
Depends on [[one-data-layer]] (same builder, ordered after it).
## Build record
Round 3 wave 1, 2026-07-13. Director-reviewed; gates green (143 tests + tsc). Commit d0e58be.
