---
slug: input-side-seeking
type: perfect/direction
context: "[[Voice Cloning & Ingest Pipeline]]"
lens: optimization
status: shipped
size: S
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: ae12f52
---
## What & why
Every segment extract decodes the entire source recording from byte zero. `to_wav` places `-ss`/`-to` AFTER `-i`, which is output-side seeking: ffmpeg demuxes and decodes everything before the start point and throws it away. With the 40-segment labelling limit on a 10-minute upload that is ~40 full decodes of the whole file, and the same pattern applies to every per-speaker preview. Moving the seek before the input makes each extract O(1) instead of O(duration). On a CPU-only Arm product this is the largest avoidable cost in the ingest pipeline.

## Evidence
- `service/ingest.py:92-98` — `cmd = ["ffmpeg", "-y", "-i", str(src)]` and only then `+= ["-ss", …, "-to", …]`. (Director-verified.)
- Callers: `service/ingest.py:373` (per labelled segment, up to `limit=40` at `:358`), `:337` (per-speaker preview, cloud), `:270` (sovereign preview).
- Cost context from the scout: one cloud job spawns 1 ffprobe + 1 clean + N previews + up to 40 segment extracts + 1 export subprocess.

## Acceptance criteria
- Input-side seeking (`-ss` before `-i`), with output-side trim retained only where frame accuracy demands it — state which, and why.
- Extract wall-clock becomes independent of the source file's length: measure before/after on a real multi-minute file and report both numbers.
- Cut audio still matches the labelled span — verify boundary accuracy rather than assuming it (input-side seeking can land on the nearest keyframe; if that matters here, use the two-stage `-ss` before + fine `-ss` after form).
- No change to the produced sample rate/channels (24 kHz mono) or to downstream stem assembly.

## Risks / non-goals
- Keyframe-accuracy is the one real trap: a fast seek that silently shifts segment boundaries would corrupt the labelled audio. Prove boundaries with a test, do not eyeball it.
- Non-goal: replacing ffmpeg, batching extracts into one invocation, or changing the 40-segment limit (that belongs to [[external-call-budget]]).

## Build record
Builder I-A. Two-stage seek: coarse `-ss (start - 0.5s)` BEFORE `-i`, fine `-ss 0.5` after `-i` (sample-accurate, decodes only the preroll), span as `-t` not `-to`. Single-stage input seeking was explicitly REJECTED by the builder because it can land on a seek point and silently shift a labelled span — the exact trap the brief named.

**Measured** (10-minute source, best of 3, x86 dev box): mp3 extract at 540s 2474ms to 115ms (21x); full 40-segment pass 40.6s to 5.6s. wav extract at 540s 240ms to 79ms (3.1x); full pass 5.5s to 4.6s. New cost is flat (~78ms, process spawn) wherever it lands, which was the acceptance criterion. Honest caveat the builder volunteered: the pipeline's own callers extract from `clean.wav`, so the WAV row is what ingest sees today; the mp3 row is what any extract from a compressed source now costs.

**Director review**: this was the one direction whose payoff could actually be measured on this box, and the builder measured it rather than asserting it. Gates on main: 341. MERGED.
