---
slug: parallel-label-commit
type: perfect/direction
context: "[[Voice Cloning & Ingest Pipeline]]"
lens: optimization
status: shipped
size: M
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 0407009
---
## What & why
Up to 40 per-segment Gemini calls run serially (blocking urlopen), one ffmpeg spawn per segment; commit spawns a fresh pocket_tts export-voice per emotion — N sequential cold model loads. Bound-parallelize labeling, batch extraction, export stems with ≤1 model load (or bounded parallel exports). Cloud ingest wall-time drops several-fold.
## Evidence
ingest.py:340-354; ingest.py:341-342; ingest.py:416.
## Acceptance criteria
- labeling uses a bounded worker pool, order-stable results
- commit ≤1 model load per batch or parallel exports
- identical stem/voice outputs vs serial
- one segment/emotion failure doesn't kill the batch
## Risks / non-goals
Gemini rate limits (keep pool small, retain escalation path); no GPU assumptions.
## Build record
Wave 2, 2026-07-13. Opus builder; Director-reviewed; gates green (compileall + 73 unittests). 0407009 (+87b5bf9 load-back verify + CLI fallback, Director). Note: export_stems in-process serializer is verified by load-back + falls back to the proven pocket_tts export-voice CLI; needs one integration run on a box with the model.
