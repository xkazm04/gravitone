---
slug: streaming-first-listen
type: perfect/direction
context: "[[tts-playground]]"
lens: feature
status: shipped
size: M
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: a7ea4fe
---
## What & why
The console's solo path buffers full synthesis while the server already offers `POST /v1/text-to-speech/{voice_id}/stream` (first-audio at first-segment time). The web ships a sophisticated apology (ticking clock, RTF estimate, "past the estimate") for a latency problem the service solved. Wiring it is the Arm demo headline: audio starts in a fraction of the time.

## Evidence
- service/app.py:1611 stream endpoint, admission decided before bytes (1631-1638)
- web/lib/engineSeam.ts:364 `streaming: false` hardcoded; :73-98 three non-streaming kinds
- PlaygroundConsole.tsx:109-185, 550-570 the apology UI
- Round-7 [[proxy-streams-audio]] (b69cc11) already made a proxy stream.

## Acceptance criteria
- Solo generate begins audible playback before full synthesis completes (progressive playback through a streaming proxy route).
- Seam capability `streaming` declared honestly; buffered fallback kept for mp3 / punch-in / script paths.
- Take card, peaks, IndexedDB persistence still work from the completed audio.
- ETA clock becomes stream progress (or disappears) on the streaming path.
- Tests for the streaming route + fallback selection.

## Risks / non-goals
- WAV over MediaSource is unsupported — progressive `<audio src>` playback of the streaming proxy response is the expected shape; builder may propose alternatives.
- Non-goal: streaming for script/performance mode.

## Build record
(pending)
Build record: P1 done. New /api/speak/stream proxy (proxyAudioPost split from proxyWavPost, one error contract); client schedules PCM16 on the shared AudioContext (reused _live/conversation shape). Builder falsified brief twice, correctly: audio-src unviable (POST body vs URL caps; MSE has no wav), and streaming CANNOT be default — /stream has no metatag grammar, so canStream = untagged+solo+wav only. First-sound latency unverifiable locally. Merged a7ea4fe.
