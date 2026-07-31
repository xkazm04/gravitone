---
slug: neutral-baseline-stem
type: perfect/direction
context: "[[Voice Cloning & Ingest Pipeline]]"
lens: feature
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 5de0b31
---
## What & why
This direction decides how every cloned voice SOUNDS, which makes it the highest product-value item in the context. The "baseline" (neutral) reference stem is built from ALL usable segments — the angry, sad and excited takes included — so the neutral embedding is a blend of every emotion in the recording. On top of that, stems are hard-spliced raw with no crossfade, no silence padding and no level matching, putting a click at every segment boundary directly into the reference audio the model learns from.

## Evidence
- `service/ingest.py:406-414` — `usable = [l for l in labelled if l.get("ok")]` then `base_dur = concat_wavs([Path(l["wav"]) for l in usable], base_wav)`: the baseline stem is EVERY usable segment regardless of its emotion label. (Director-verified.)
- `service/ingest.py:116-118` — `concat_wavs` writes raw frames back to back; no crossfade, no padding, no level match.
- `service/ingest.py:117-123` — the 30s cap appends BEFORE breaking, so the written file can exceed `cap_seconds` while the returned duration is clamped to it: the reported length and the actual file disagree.
- `service/ingest.py:414` (baseline uses `base_dur`, the written file) vs `:422` (emotion stems judge `eligible` on `total`, the sum of labelled durations) — two different bases, so a stem the UI marks eligible can be skipped at commit when `ingest.commit` re-measures the real file (`:491-493`) with no user-visible reason.

## Acceptance criteria
- The baseline stem is built from genuinely baseline-labelled audio, with a stated, visible fallback when there is not enough of it (never silently blend emotions back in).
- Segment splices are crossfaded and level-matched so boundary artefacts do not enter the embedding; the change is audible-safe (no clipping, no level pumping).
- The reported duration always matches the written file — cap semantics fixed in whichever direction the builder argues for, documented.
- Eligibility is computed from the same measurement `commit` will use, so the UI cannot promise a stem that will not ship.
- Tests for `concat_wavs` (cap behaviour, empty input) and for stem assembly (baseline composition, emotion grouping, ordering) — the whole assembly path is currently untested.

## Risks / non-goals
- Changing what goes into the baseline changes cloned-voice output — this is the point, but it means the builder must state exactly what the new baseline contains and what happens on a recording with no neutral segments.
- Cannot be verified by ear on this box (no pocket-tts): the builder reports what it could not hear, and the check moves to the Arm box.
- Non-goal: changing the emotion taxonomy or the labelling model.

## Build record
Builder I-A (+ Director docstring fix `89769e0`). `plan_baseline()` builds the neutral stem from baseline-labelled segments ONLY; if that is under `MIN_STEM_SECONDS` it tops up JUST enough to clear the bar, nearest-neutral first (`BASELINE_BORROW_ORDER = calm, confused, sad, happy, excited, angry, whisper` — whisper last because it lacks full phonation and is the worst thing to teach a neutral embedding). Every borrow sets a `note` that renders in the review table as a `mixed` badge plus the sentence; no neutral audio at all yields a note saying "only 0.0s of neutral speech in this recording". Splicing: per-segment gain toward the group MEDIAN RMS clamped 0.5-2.0 (anti-pumping), held under a 0.97 peak ceiling (anti-clipping), 10ms raised-cosine fades, 80ms silent gap — a crossfade THROUGH silence rather than an overlap, which would smear two unrelated utterances together. `cap_seconds` is now a hard ceiling on the written file at whole-segment granularity (the old code appended and THEN broke, so the file could exceed 30s while the reported number was clamped); `concat_wavs` returns `Splice(seconds, segments)` measured from frames actually written. Eligibility for every stem is now `written_seconds >= min_stem` — the identical measurement `commit()` re-takes.

**Director review**: read `plan_baseline` in full. Accepted a small out-of-scope excursion into `web/` (two additive lines rendering the `note`) — dropping the backend's own honesty note would have recreated the exact dishonesty this direction fixes, and it is squarely the repo's honest-failure-surfaces law. The builder could not typecheck web (no node_modules in its worktree); the Director ran `npx tsc --noEmit` + vitest on main: clean, 76/76. **Director fix 89769e0**: `plan_baseline`'s docstring claimed segments "stay in recording order" — true for the neutral ones, but borrowed segments are APPENDED after them, so the stem is not one continuous timeline. Corrected rather than left, per the round-4 rule about comments asserting properties the code lacks.

**MERGE INCIDENT (Director error, caught before it stuck)**: I-A reported direction 1 then direction 2, but had COMMITTED them in the reverse order (`a911f81` seeking is the parent, `061dab6` baseline is the tip). Resolving a conflict by taking `a911f81`'s file therefore silently reverted the entire baseline rewrite. Caught because the commit summary read "491 deletions" for what should have been additive; diffed main against the builder's branch, found the mismatch, reset and re-applied in true parent order, then verified main matches the branch byte-for-byte BEFORE running any gate. Lesson: never infer commit order from a report's narrative order — check the graph.

**Unverifiable here**: pocket-tts is absent, so the audible result is unheard. On the Arm box, listen to a baseline Voice cloned from a mixed-emotion recording for (a) a flatter default read that no longer drifts toward whichever emotion dominated the source, and (b) absence of ticks at segment boundaries (~2-15s intervals). Gates on main: 341 + tsc + 76 web. MERGED.
