# REPORT — F-LEDGER (Fidelity Ledger), Batch 1

> Saved by the orchestrator from the builder's inline report.

**Status: complete. Tests green: yes. Hooks needed: no (one integration note).**

Files touched (9): `service/voices.py`, `service/tests/test_fidelity.py` (new, 36 tests);
`web/app/voices/_data/characters.ts`, `_data/fidelity.test.tsx` (new, 26 tests),
`_variants/SignalChip.tsx` (new), `_variants/CharacterTable.tsx`,
`[characterId]/_variants/EmotionRack.tsx`, `[characterId]/_variants/GuidedRecorder.tsx`
(one additive prop), `[characterId]/CharacterVoices.tsx`.

Gates: assigned service suites 116 OK (+ ingest_truth/clone_path/handler_modes/character_read/
registry_cache/registry_atomic/pack_safety green); py_compile OK; tsc clean; full vitest 32 files /
351 tests pass.

## Contracts
**C1** — `measure_fidelity(wav, *, identity=None, source_rate=None) -> dict | None` exact shape,
numpy + wave + `vad.frame_db`, once at clone time. Surfaced on GET /v1/characters, [id] route,
character_manifest. `create_voice(..., *, fidelity_identity=None)`.

Judgement calls:
1. NOT `vad.SpeechGate` (forward-only floor tracking reported `speech_seconds: 0.0` + false
   `short_speech`/`noisy` flags on a good loudnorm'd take). Shipped: two-ended threshold
   (floor@p10 / speech@p95, same as `ingest.measure_levels`); degenerate distribution → decide by
   absolute level, leave `noise_floor_db` unmeasured.
2. `low_sample_rate` judged on the SOURCE upload (clean_audio resamples to 24 kHz); non-wav
   upload = unknown → no flag.
3. Unmeasurable ⇒ no `fidelity` key at all (null), never an object of nulls.

**C2** — hook implemented verbatim; build-order-independence proven by hiding the prosody module
in tests; probe result asserted against the real module.

**C5** — snake_case/nullable wire → `readFidelity` translates at the ONE fetch boundary
(loadRoster, fetchCharacter, cloneVoice); an object with no facts → undefined → renders nothing.

**label_check — WIRED.** `voices.label_check_for()` → `Voice.label_check` on the create response
only (never stored, never on read routes). ⚠ `emotions.label_check` takes `Iterable[Mapping]` —
passing the registry dict iterates KEYS and returns None forever; we pass `list(...values())`; asserted.

## Security catch
FastAPI bound `fidelity_identity` as an optional QUERY parameter on the clone route (verified
against live OpenAPI schema) — any caller could assert `identity 0.99` unmeasured. Fixed:
keyword-only + separate `clone_voice_endpoint`; `test_fidelity` pins that it is absent from the
endpoint's params/body, still keyword-accepted, and both functions stay `def`.

## Integration notes
- F-LOOP callers: reuse `voices.measure_fidelity` rather than re-deriving; `FIDELITY_VERSION` is
  the bump point.
- GuidedRecorder still has one raw `<audio controls>` — left for orchestrator swap (SIGNAL barred
  from web/app/voices/**).
- `.gravichar`: manifest carries fidelity; verify `packs.py` copies rows wholesale at integration.

## UX per §2
One shared `SignalChip` for rack + roster. No 0-100 anywhere: `clipped`, `1.4s speech`,
`identity 0.91`; flags ranked clipped > low_sample_rate > noisy > short_speech; unknown flags shown
verbatim, ranked lower. Hover text: "Identity match… says nothing about whether the take is good"
(test asserts "quality" never appears). Null signal → null render; pre-ledger slots render exactly
as before (asserted). `weakestVoice` counts only FLAGGED voices. Advisory throughout. `↻ re-record`
on flagged slots; roster hint IS the `?record=` link; recorder shows defect-specific direction.
Amber = flags, cyan = clean measured facts, no new hex. title + aria-label on every chip.
`weakest` sort lives in the demand header cell.

## Deferred (M2)
Emotion-separation half of step 3 (build on E-SPACE prosody space later); `.gravichar` export
(packs.py outside ownership); threshold calibration against labelled bad takes (constants named +
two-side tested).

## Observed, not mine
`test_emotion_fallback...test_every_base_scale_emotion_has_a_prior` failed once mid-window while
E-SPACE was mid-write (baseline missing from EMOTION_PROSODY_PRIOR) — E-SPACE later removed
baseline's prior BY DESIGN (origin, not direction). Verify in the final full gate.
