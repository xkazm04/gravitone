---
slug: one-transport-in-the-lab
type: perfect/direction
context: "[[voice-creation-studio]]"
lens: ux
status: shipped
size: S
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: 011aa34
---
## What & why
The review screen runs two audio systems at once: the page's private new Audio() ref (stem / hear-as-voice playback) and SegmentBoard's shared TakePlayer — two clips can literally play simultaneously. AuditionPanel's own comment admits the debt. Round 9 built useTransport for exactly this consolidation.

## Evidence
- page.tsx:283 private Audio + playClip :280-289; SegmentBoard.tsx:4,282 TakePlayer/AudioBus
- AuditionPanel.tsx:26-28 the admission; components/ui/useTransport.ts:1-16 names this anti-pattern

## Acceptance criteria
- Page playback + AuditionPanel adopt useTransport/TakePlayer; the private Audio ref goes.
- Concurrent playback mutually exclusive (AudioBus semantics) — tested.
- Casting/audition behavior tests stay green.

## Risks / non-goals
Non-goal: redesigning the players' look. Blob-URL lifecycle in useAudition must survive the swap.

## Build record
(pending)
Build record: S-B done. Page's private Audio deleted; one bus-registered element via useTransport; exclusivity module-level, driven by the PLAY EVENT (a failed play can't pause the current clip); app-wide now — future dual-playback surfaces need an opt-out. AuditionPanel adopted for free. Merged 011aa34.
