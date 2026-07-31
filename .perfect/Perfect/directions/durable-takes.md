---
slug: durable-takes
type: perfect/direction
context: "[[TTS Playground]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: ec88a5e
---
## What & why
Refresh destroys the session (takes in component state); object URLs never revoked; new AudioContext per take (browsers cap them); share/ensureShared duplicate upload paths; orphan /api/tts prototype route ships unused. Persist takes to IndexedDB (blobs + metadata, restored on load), revoke URLs, one AudioContext, one upload helper, delete orphan route.
## Evidence
PlaygroundConsole.tsx:64 (ephemeral takes), :117-163 (dup upload); engine.ts:9-27 (AudioContext per take); web/app/api/tts/route.ts (orphan).
## Acceptance criteria
- refresh restores the take log (playable)
- no URL/AudioContext leaks
- one shared upload helper
- /api/tts removed, nothing broken
## Risks / non-goals
No cross-device sync; storage quota handled gracefully.
## Build record
Round 2 wave 1, 2026-07-13. Opus builder; Director-reviewed; gates green (113 unittests + tsc). ec88a5e (kept /api/tts — NOT an orphan: HeroMicDemo, data.ts, MigrationKit call it; scout claim wrong, builder DECISION correct).
