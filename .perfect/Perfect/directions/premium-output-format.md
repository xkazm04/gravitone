---
slug: premium-output-format
type: perfect/direction
context: "[[Speech Synthesis API]]"
lens: ux
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 70b7f63
---
## What & why
`/v1/speak` and `/v1/performance` hardcode `audio/wav` with no `output_format` parameter at all. The full format grammar — mp3 bitrates, pcm, sample rates — exists, is well tested, and is available only on the ElevenLabs-compatible route. So the two routes that are actually Gravitone's differentiator are the two you cannot get an mp3 from, which matters most for the multi-character performance output someone would actually want to share.

## Evidence
- `service/app.py:1114` and `:1203` — `media_type="audio/wav"`, hardcoded.
- `service/app.py:1053-1056` and `:1137` — neither signature has an `output_format` Query parameter.
- `service/app.py:651-692` — `_parse_format` and the full grammar, with a 400 listing supported formats, already exist and are tested (`test_compat.py:81-231`).

## Acceptance criteria
- Both routes accept the same `output_format` grammar as the drop-in route, REUSING `_parse_format` rather than re-implementing it.
- The same early-400-with-supported-list behaviour on an unsupported format.
- mp3 encoding and pcm/wav resampling go through the existing offloaded paths, so the event loop is not blocked (`test_handler_modes.py` guards this).
- Header parity where applicable (`X-Sample-Rate` on pcm, and the diagnostics from `honest-self-reported-numbers`).
- Default stays `wav_24000` so existing callers are byte-identical.

## Risks / non-goals
- Coordinate with [[honest-self-reported-numbers]] — both touch the same two response blocks; if one builder owns both, say so in the commits.
- Non-goal: mp3 on the streaming route (still 501 by design — it needs the complete clip).

## Build record
Builder S1. `output_format` on both premium routes, reusing `_parse_format` (same early 400 with the supported list, before any job is submitted). Default `wav_24000` → byte-identical responses for existing callers. `X-Sample-Rate` on pcm; timing headers measured BEFORE conversion so the realtime factor stays a claim about the model and is comparable across formats. Streaming mp3 still 501 by design.

The builder extracted `_encode_audio` as the single renderer and converted the drop-in route's inline block to call it — flagged explicitly as the one edit outside its named regions, with the reason: keeping a second copy of the format branch would have been two answers to "what does `pcm_16000` mean". Accepted; it is the same consolidate-don't-fork instinct the briefs ask for, and it touched no sibling's region.

**Director review**: verified the extraction did not move transcode/resample off the executor (`test_handler_modes` still green, which is what guards it). Gates on main: 469 + 72 subtests. MERGED.
