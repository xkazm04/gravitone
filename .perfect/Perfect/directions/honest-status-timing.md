---
slug: honest-status-timing
type: perfect/direction
context: "[[TTS Playground]]"
lens: ux
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 100e857
---
## What & why
Proxies drop X-Synth-Seconds/X-Queue-Seconds/X-Ignored-Settings, so the quality slider gives no latency feedback and every failure (429/502/down) collapses into the browser-voice fallback banner. Forward headers, show synth/queue per take, warn on ignored settings, distinct "server busy — retry" for 429, error toast in generate().
## Evidence
speak/route.ts:22-25 (headers dropped); engine.ts:57-100 (error collapse); PlaygroundConsole.tsx:187-200 (no catch).
## Acceptance criteria
- per-take synth + queue times visible
- ignored-settings warning renders
- 429 state distinct from backend-down fallback
- generate errors surface as a toast
## Risks / non-goals
No retry automation; no streaming.
## Build record
Round 2 wave 1, 2026-07-13. Opus builder; Director-reviewed; gates green (113 unittests + tsc). 100e857.
