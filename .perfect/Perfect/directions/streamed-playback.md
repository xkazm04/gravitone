---
slug: streamed-playback
type: perfect/direction
context: "[[TTS Playground]]"
lens: optimization
status: rejected
size: M
proposed: 2026-07-13
---
## What & why
Wire /v1/text-to-speech/{id}/stream into the playground via a pass-through proxy + Web Audio PCM chunk playback for untagged text.
## Rejection
2026-07-13 — user declined. Caveat noted at proposal: only untagged text could stream (no /v1/speak stream variant). Re-propose only if a speak-stream backend route ships.
