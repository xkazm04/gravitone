---
slug: stop-saying-false-things
type: perfect/direction
context: "[[Voice Creation Studio]]"
lens: robustness
status: shipped
size: S
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 10684c3
---
## What & why
Four separate statements the studio makes that today's code contradicts. The worst: the `label_errors` banner tells the user failed segments "fell back to the baseline stem", while the code comment three lines above the relevant filter says the exact opposite — an unlabelled segment is deliberately UNUSED precisely so it cannot pollute the neutral stem. The same banner says those segments "couldn't be classified", conflating ffmpeg-decode failures with classifier failures, which round 5 deliberately split apart. The page header claims "we transcribe & diarize it" unconditionally, which is false in sovereign mode and is the first sentence on the page. And the review header reports a speaker count that in sovereign is always 1 — asserting single-speaker exactly where the sovereign limits warn that everyone audible gets cloned into one voice.

## Evidence
- `web/app/voices/new/page.tsx:303` and `_loaders/WaveformLab.tsx:91` — "they fell back to the baseline stem" / "falling back to baseline". `service/ingest.py:1118-1121` comment: "An unlabelled segment is UNUSED, not baseline audio... guessing 'neutral' would quietly pollute the one stem that must stay pure", enforced by the `usable` filter at `ingest.py:1177`. (Director-verified.)
- Same banner: "couldn't be classified" — but round 5 split `extract_errors` (ffmpeg decode) from `classify_errors` (`ingest.py:1131-1133`); the UI reads only the legacy total `label_errors`.
- `service/ingest.py:1121` — `counts[lab["emotion"]]` is incremented for FAILED segments too, so the live `EmotionTally` over-reports baseline mid-scan while the stem excludes them.
- `web/app/voices/new/page.tsx:200` — "we transcribe & diarize it", unconditional; sovereign does neither.
- `web/app/voices/new/page.tsx:296` — `result.speakers.length`, always 1 in sovereign (`ingest.py:891`); `:273` also reads "1 speakers detected" (no pluralization).
- `web/app/voices/new/page.tsx:310` — "'Short' stems are below the clone threshold" without showing `result.min_stem`, which is already on the result (`ingest.py:1221`).

## Acceptance criteria
- Each of the four statements is true in BOTH modes, or is mode-aware.
- Extract failures and classify failures are described as what they are, using the counters round 5 created.
- The live emotion tally stops counting failed segments as baseline.
- The speaker count does not assert single-speaker in a mode whose stated limit is that it cannot tell speakers apart.
- `min_stem` is shown next to the short-stem explanation instead of an unnamed threshold.

## Risks / non-goals
- This is a copy-and-truth direction, not a redesign: do not restructure the review screen.
- Every replacement string must be checked against the CODE, not against the old string's intent — the failure mode here was copy that described what someone assumed the pipeline did.
- Non-goal: changing what the pipeline does with failed segments (the current behaviour is correct; the description is what is wrong).

## Build record
Builder W1. `segmentFailureNote()` replaces both "fell back to the baseline stem" strings — verified against `ingest.py`'s `usable` filter, so the copy is now "left out of every stem … never folded into the baseline", broken down by `extract_errors` vs `classify_errors` with the legacy total still rendering correctly. `usableCounts()` subtracts failed segments from the `baseline` bucket in `WaveformLab`, so the live tally matches what the stem builder will actually splice. The page subtitle, speaker-pick heading and review ledger are mode-aware: sovereign says "single speaker assumed (no local diarization)" instead of a diarization count; cloud pluralizes. `result.min_stem` is named in the short-stem explanation. The builder also found a fifth of the same family unprompted — the loader quoted sovereign's own note as a transcript — and fixed it.

**Director review**: this direction's whole risk was repeating the original failure mode (writing copy from an assumption about the pipeline), and the brief said to check every replacement against the CODE. Verified `segmentFailureNote`'s text against `ingest.py:1118-1121` and the `usable` filter: it is now accurate. Gates: tsc clean, 90 web tests (76 + 14 new), 469 service. MERGED.
