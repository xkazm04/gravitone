# REPORT — E-SPACE (Measured Emotion Space), Batch 1

> Saved by the orchestrator from the builder's inline report (harness blocks subagent .md report writes).

**Status: complete. 6 files touched. Tests green: yes (full suite 875 OK, skipped=5). Hooks needed: 3.**

## Files
- `service/prosody.py` (new) — C2 probe, pure `wave`+numpy.
- `service/tools/__init__.py` + `service/tools/prosody_backfill.py` (new).
- `service/emotions.py` (additive) — `PROSODY_FIELDS`, `EMOTION_PROSODY_PRIOR`, `prosody_vector`,
  `nearest_measured`, `label_check`, `resolve(..., *, prosody=None)`.
- `service/tests/test_prosody.py` (new, 37) + `test_emotion_fallback.py` (12 → 41; nothing weakened).
- Untouched as required: `service/voices.py`, `service/ingest.py`, all `web/`.

## C2 probe
Exact contract shape plus honesty fields: `version` stamped on every result (including degraded);
numeric fields `float | None` (None = unmeasured, never zero); `reason` key only when degraded
(`empty`/`too_short`/`silent`/`no_speech`/`unvoiced` — `unvoiced` is partial: a whisper keeps
energy/rate/tilt). Only `ProbeError` (a ValueError) raised, only for unreadable audio. Deterministic.

Decisions: (1) level threshold copied from `ingest.measure_levels`, NOT vad.py — vad's floor-only
gate (clamped to −12 dBFS) would gate out a loudnorm'd clean.wav entirely; constants asserted equal
to ingest's so they can't drift. (2) FFT autocorrelation with parabolic refinement — integer-lag
pitch would surface as fake `f0_sd`.

## Backfill tool
`python -m service.tools.prosody_backfill [--dry-run] [--limit N] [--voices-dir DIR]`. Plan phase
reads `_meta.json` with plain json (no service import). Targets: no prosody, stale version, or
reason-only. On this box every slot reports `skipped: engine unavailable (torch)`, exit 0 (tested).
Writes via `voices.mutate_meta`, only when something was measured.

## Design correction worth flagging
First implementation (z-scored Euclidean) was useless — the most AVERAGE slot won nearly every
comparison. Shipped metric: **cosine distance over the Character's own z-space** — direction, not
magnitude. Consequence: `baseline` has no prior (it is the origin), so a missed `baseline` request
keeps the unchanged deterministic tail.

## resolve() measured mode
Miss walk: measured nearest → `FALLBACK_CHAIN` → baseline → `deterministic_fallback`. With
`prosody` omitted, behaviour is byte-for-byte pre-batch (pinned by `ColdStartUnchangedTests`).
Measured mode declines (defers to chain) when it can't carry the decision: no prior (every custom
emotion), <2 measured slots, no spread, no shared field. Ties break on scale order then name —
same ordering as `deterministic_fallback`, so resolve and `character_manifest` can't disagree.

## Hooks required
1. **F-LEDGER, voices.py — C2 hook + label_check on the response.** In `create_voice` (where
   `clean` is in scope): probe via `prosody.probe(clean)` in try/except-warn; then
   `label = emotions.label_check(probe, emotion, rows_of_this_character)` in try/except-warn.
   In `_commit(meta)`: `meta["voices"][voice_id]["prosody"] = probe` when probe is not None.
   `Voice` model gains optional `label_check: dict | None = None` (response-only, never persisted);
   `return Voice(..., label_check=label)`.
2. **F-LEDGER, voices.py — `prosody_map(character_id) -> dict[str, dict]`** beside `emotion_map`:
   same one-voice-per-emotion reduction, returns emotion→stored prosody for measured slots only.
3. **Orchestrator, app.py (unowned) — 3 call sites** (`app.py:583`, `1305`, `1419`): import
   `prosody_map` alongside `emotion_map`, pass `prosody=prosody_map(character_id)` to `resolve`,
   hoisted out of the per-segment loops at 1305/1419. Until this lands, measured mode is dormant
   and every caller gets exact pre-batch behaviour.
4. Optional, batch 2: `packs.py` should carry `prosody` on exported rows.

## Test evidence
test_prosody 37 OK · test_emotion_fallback 41 OK · + registry_invariants/private_surface/
ingest_external/ingest_pipeline: 160 OK · full discover: 875 OK (skipped=5) · py_compile clean ·
ASCII only. Coverage: 200 Hz tone reads 200±3 Hz; vibrato > monotone f0_sd; louder/brighter/faster
orderings hold; stereo/8-bit/8 kHz decode; silence/short/empty/junk/24-bit/missing each named.
`ProbeFeedsEmotionsTests` runs real synthesized audio through probe→resolve/label_check (the seam).

Transient during gates: `test_ingest_external`/`test_ingest_pipeline` briefly failed on
`KeyError: 'label_errors'`/`'extract_errors'` while F-LOOP was mid-edit in ingest.py; both pass now.

## §2 compliance
No composite score — `label_check` returns a label (`nearest`) with `distance` secondary. Absent =
invisible (prosody optional everywhere; label_check → None, not placeholder). Advisory never
blocking. Per-speaker normalisation. Prior table documented as heuristic, never as measurement.

## Deferred (per §5)
Affect plane/_affect.json/coords (step 2), coordinate addressing + hull (step 5 — custom emotions
need this; today they decline to the deterministic tail, tested + documented), coverage-as-area
(step 6), M1 entirely.
