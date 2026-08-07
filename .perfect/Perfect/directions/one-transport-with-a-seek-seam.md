---
slug: one-transport-with-a-seek-seam
type: perfect/direction
context: "[[tts-playground]]"
lens: ux
status: shipped
size: M
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: cdad11a
---
## What & why
Five parallel audio transports (TakePlayer, useAudioPlayer, TakeCard's private `new Audio`, ScoreEditor's audioRef, NarrationDock's ref). Consequence, not cosmetics: TakeScore explicitly gave up seeking because TakeCard exposes no seek seam — the new score surface is read-only by inherited duplication. The share page also draws segments twice (ribbon + score).

## Evidence
- components/ui/TakePlayer.tsx:3-8 "the one transport" claim; TakeCard.tsx:63 private Audio
- TakeScore.tsx:22-24 the surrender comment; :105-131 duplicate segment timeline vs TakeCard.tsx:149-168 ribbon
- useAudioPlayer.ts (playground), ScoreEditor.tsx:81, NarrationDock.tsx:409

## Acceptance criteria
- One transport with a seek seam serves TakeCard + TakeScore on /t/[id]; clicking the score seeks.
- Duplicate ribbon/score display consolidated to one segment surface.
- Playground-console migration may be partial (non-goal to rewrite the console player this round), but no NEW transport is added.
- Existing player/score tests stay green; new tests for seek-from-score.

## Risks / non-goals
- NarrationDock/ScoreEditor migration optional; do not regress narrator.

## Build record
(pending)
Build record: P2 done. TakePlayer's state machine lifted into useTransport() (play/pause/seek/fraction seeks); TakeStage owns one transport for card+score on /t/[id]; Track gained pointer-scrub + keyboard seeking; score primary, ribbon = fallback when segments can't be placed + embed. Builder nuance: TakePlayer WAS used in 6 places — the real defect was no seam + share page not among them. Merged cdad11a.
