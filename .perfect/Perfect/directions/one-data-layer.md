---
slug: one-data-layer
type: perfect/direction
context: "[[Character & Voice Management]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: a073c9e
---
## What & why
useCharacters (data.ts:54-112) and useCharacterVoices (useCharacterVoices.ts:19-131) duplicate fetch/CRUD and have drifted (consent handling in only one). Preview failures swallowed (data.ts:144-146); removeVoice ignores response (useCharacterVoices.ts:119-125); successful PATCH never re-syncs server-normalized values (data.ts:91-103); dead disabled "replace" button (EmotionRack.tsx:132-134). One hook module, visible failure paths, re-sync on success, wire-or-remove the dead control.
## Acceptance criteria
- one shared data module used by both pages
- preview/delete failures surface to the user
- PATCH re-syncs on success
- no dead disabled controls
- tsc green
## Risks / non-goals
Behavior-preserving consolidation; no visual redesign.
## Build record
Round 3 wave 1, 2026-07-13. Director-reviewed; gates green (143 tests + tsc). Commit a073c9e.
