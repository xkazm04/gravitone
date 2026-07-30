# Batch 1 Design — "The Studio Hears Itself"

> Five features, one story: **Gravitone measures its own voices and shows you, honestly and
> beautifully.** The clone pipeline hears its output (Fidelity Loop), the roster reports what it
> heard (Fidelity Ledger), emotions become measured geometry instead of asserted labels
> (Measured Emotion Space), the studio lets you audition candidates before committing
> (Audition Room), and the whole interface breathes with the actual audio (Signal Layer).
>
> Branch: `vibeman/moonshot-batch-1` (off `main`). Builders NEVER run git. Orchestrator commits.

## 1. The UX narrative (why users comprehend this as one package)

The batch introduces ONE new visual concept the user meets everywhere: the **Signal chip** —
a small glass chip in the measurement accent that states a *named, measured fact* about audio
("identity 0.91", "clipped", "reads closer to calm"). Wherever the studio measured something,
a Signal chip appears; where nothing was measured, NOTHING appears. The second concept is
**liveness**: surfaces visibly react to real audio (Signal Layer), so "the studio hears" is
not a claim, it's what the UI does.

User journey after this batch ships:
1. Create a voice → review screen shows per-stem Signal chips (outlier segments flagged) and an
   **"hear it as a voice"** audition button per emotion; pick the candidate that wins your ear.
2. Commit → each Voice lands in the roster carrying its measured facts.
3. Roster → EmotionRack shows compact fidelity per slot; CharacterTable's coverage bar gains a
   worst-slot hint; weakest voice is one click from a re-record.
4. Recording a new emotion → non-blocking "label check" chip if it reads closer to a different
   emotion; emotion fallback silently improves (nearest measured neighbour, not a hardcoded chain).
5. Everywhere → players are the new TakePlayer (no browser chrome), equalizers move with REAL
   audio, the frame's aurora leans into the active character's hue.

## 2. Design rules (bindings for ALL builders)

- **Named facts, not opaque scores.** Flags like `clipped`, `1.4s speech`, `identity 0.91` beat
  a bare "73/100". A numeric score may appear as a secondary detail, never as the headline.
- **"Identity match", never "quality".** Embedding similarity is presented as identity, verbatim.
- **Absent = invisible.** `fidelity`/`prosody`/`coords` are all optional. Old rows have none.
  UI renders nothing for absent data — no placeholders, no "not measured" noise.
- **Advisory, never blocking.** Label checks and fidelity warnings inform; they never prevent
  a commit or a save.
- **Tokens only.** No new hex literals in web code. Use `web/components/ui/tokens.ts` values /
  the new `--gt-*` CSS variables. The measurement accent is the existing cyan accent.
- **Motion discipline.** Honour `prefers-reduced-motion` and the existing `anim-paused`
  convention at the bus level; reduced motion = static level indication, no oscillation.
- **No raw `<audio controls>`** in any new or touched surface — use `<TakePlayer>` (Signal
  Layer delivers it; other web builders use existing primitives and the orchestrator swaps in
  TakePlayer at integration if it lands first — do NOT block on it).
- **A11y**: every chip has a title/aria-label; players and A/B controls are keyboard-operable.
- **Service honesty style**: every degraded outcome is named in payloads (the codebase's
  "name the outcome" convention); no silent skips.

## 3. Shared contracts (exact, implement precisely)

### C1. Fidelity object (registry row, owned by `service/voices.py`)
```python
"fidelity": {
  "version": 1,
  "measured_at": "<iso8601Z>",
  "identity": 0.91 | None,        # cosine sim to reference speaker; ingest supplies it
  "speech_seconds": 6.2 | None,   # VAD-derived effective speech
  "clip_ratio": 0.002 | None,     # fraction of near-full-scale samples
  "noise_floor_db": -52.1 | None,
  "flags": ["clipped","noisy","short_speech","low_sample_rate"],  # only true ones
}
```
`create_voice(...)` gains keyword-only `fidelity_identity: float | None = None`.
voices.py computes the signal-only half itself (numpy + wave over the clean audio it already
has), merges `identity` if supplied, stores the object on the registry row, and surfaces it in
`GET /v1/characters`, the `[id]` route, and `character_manifest`. Absent must read as
"not measured" (`fidelity: null`), never zero.

### C2. Prosody probe (new `service/prosody.py`, pure numpy + wave, no torch)
```python
def probe(wav_path: str | Path) -> dict:
    # {"f0_mean": float, "f0_sd": float, "energy_rms": float,
    #  "rate_proxy": float, "spectral_tilt": float, "version": 1}
```
Hook (implemented by the voices.py owner, exactly this shape):
```python
try:
    from service import prosody
    meta_row["prosody"] = prosody.probe(clean_wav_path)
except Exception as exc:  # advisory: never fail a clone over a probe
    log.warning("prosody probe skipped: %s", exc)
```

### C3. Voiceprint (new `service/voiceprint.py`, mirrors diarize.py discipline)
```python
def available() -> bool
def embed(wav_path) -> np.ndarray          # raises Unavailable when sherpa-onnx/model absent
def similarity(a, b) -> float              # cosine, [-1, 1]
class Unavailable(RuntimeError): ...
```
Lazy sherpa-onnx import + model at `diarize.embedding_path()`; same lock/lazy-load pattern.
**sherpa-onnx is NOT installed on this dev box** — all tests must stub it; runtime degrades to
"fidelity.identity = None" with a named reason in payloads.

### C4. Signal Layer CSS variables (written by AudioBus on ONE scoped node)
`--gt-level` (0..1 RMS), `--gt-peak` (0..1), `--gt-centroid` (0..1 brightness),
`--gt-hue` (deg), `--gt-working` (0|1 — synthesis in flight).
Design tokens exported as `--gt-accent-cyan`, `--gt-surface-top`, `--gt-ease`, etc. via a
`<GravitoneTokens>` style tag in `layout.tsx`. Readers use transform/opacity/filter only.

### C5. Web Voice type (owned by `web/app/voices/_data/characters.ts`)
```ts
fidelity?: { identity?: number; speechSeconds?: number; flags: string[] }
```
Renders nothing when absent. Signal chip component lives with the rack (F-LEDGER builds it,
styled per §2); if SIGNAL ships a generic chip primitive later, orchestrator consolidates.

### C6. Audition endpoint
`POST /v1/ingest/{job}/audition {emotion, text, recipe?}` → wav bytes (+ `X-Audition-*` meta
headers). Scratch voice id prefixed `_audition_`, never registered in the roster meta, cleaned
per-request and by GC. Web proxy: `web/app/api/ingest/[job]/audition/route.ts`.

## 4. File ownership (HARD boundaries — do not edit outside your set)

| Agent | Owns (create/edit) | Must NOT touch |
|---|---|---|
| **F-LOOP** (Fidelity Loop) | `service/voiceprint.py` (new), `service/ingest.py`, `service/tests/test_voiceprint.py` (new) + minimal edits to existing `test_ingest_*` | `service/voices.py`, `service/ingest_api.py`, `service/export_stems.py`, all web |
| **F-LEDGER** (Fidelity Ledger) | `service/voices.py`, `service/tests/test_fidelity.py` (new), `web/app/voices/**` EXCEPT `web/app/voices/new/**`, `web/app/api/characters/**`, `web/app/api/voices/**` | `service/ingest.py`, `service/emotions.py`, `web/app/voices/new/**`, `web/components/**` |
| **E-SPACE** (Measured Emotion Space) | `service/prosody.py` (new), `service/emotions.py`, `service/tests/test_prosody.py` + emotions tests | `service/voices.py` (hook C2 is implemented by F-LEDGER), all web |
| **AUDITION** (Audition Room) | `service/export_stems.py`, `service/ingest_api.py`, `service/tests/test_audition.py` (new), `web/app/voices/new/**`, `web/app/api/ingest/**` | `service/ingest.py`, `service/voices.py`, `web/app/voices/*` outside `new/`, `web/components/**` |
| **SIGNAL** (Signal Layer) | `web/components/ui/**`, `web/components/variants/**`, `web/app/globals.css`, `web/app/layout.tsx`, `web/app/playground/_variants/useAudioPlayer.ts` (registration only) | everything under `service/`, `web/app/voices/**`, `web/app/keys/**` |

Where two features need the same seam, the contract above says who implements it. If you
discover a genuinely missing seam, DO NOT edit the other agent's file — write the exact needed
change into your report's "hooks required" section; the orchestrator integrates.

## 5. Per-feature batch-1 scope

### F-LOOP — Fidelity Loop (svc) — proposal `cloning-ingest.md` M1, steps 1–3 only
1. `service/voiceprint.py` per C3.
2. Measurement in `label_and_stem`/result-building: embed stems + reference, publish
   `fidelity: {reference_similarity, per_segment_outliers}` in existing partial/result payloads;
   flag segments whose embedding sits far from the speaker centroid (report; drop only when
   clearly foreign, in the pipeline's "name the outcome" style).
3. Commit close-the-loop: after export, synthesize one calibration line via the existing child
   path, score vs reference, pass score into `create_voice(fidelity_identity=...)`
  (parameter exists per C1). When voiceprint unavailable → named skip, identity=None.
NOT in batch 1: beam-search stem optimization, threshold refusals. Tests: stub sherpa
(pattern: `fake_engine.py` shims); prove degrade path + payload shape + outlier flagging with
synthetic embeddings.

### F-LEDGER — Fidelity Ledger (svc+web) — proposal `character-voice-management.md` M2, full
Service: C1 schema + signal-only metrics (use `service/vad.py` for speech seconds) + C2 hook +
`fidelity` in characters/manifest APIs. Web: Voice type (C5), Signal chip in `EmotionRack`
(compact: worst flag or `identity 0.91`), worst-slot hint in `CharacterTable` coverage bar,
`re-record` affordance linking to the guided recorder with the defect pre-loaded (deep-link
param the recorder already supports: `?record=`), roster sort `weakest` beside `demand`.
UX per §2: chips, absent=invisible, advisory.

### E-SPACE — Measured Emotion Space (svc) — proposal `voice-emotion-library.md` M2, steps 1+3+4
1. `service/prosody.py` per C2 + backfill tool `service/tools/prosody_backfill.py` (built-ins:
   synthesize calibration line when engine available; degrade to "skipped: engine unavailable").
2. Label check: pure function `emotions.label_check(prosody_vec, declared_emotion, character_rows)
   -> {agrees, nearest, distance} | None` — exposed on the create-voice response path via a
   field the C2 hook stores (voices.py returns it if present; document exact plumbing in report).
3. `resolve()` measured mode: on a miss, nearest available slot by prosody distance in the
   character's own measured space; `FALLBACK_CHAIN` stays as cold-start default; final rung
   stays `deterministic_fallback` (behaviour must remain deterministic + tested).
NOT in batch 1: 2-D affect plane calibration/_affect.json, coordinate addressing, coverage-as-area.
Tests: synthetic prosody vectors prove nearest-neighbour fallback + determinism + cold-start.

### AUDITION — Audition Room (svc+web) — proposal `voice-creation-studio.md` M1, steps 1–3
1. Scratch export mode in `export_stems.py` (ephemeral, `allow_short=True`, never touches the
   roster registry, `_audition_` prefix + GC sweep) and `POST /v1/ingest/{job}/audition` (C6)
   in `ingest_api.py` (cheap admission: does not consume a job slot).
2. 2–3 recipes per emotion from the segments the job already has (longest /
   highest-confidence / tightest); result payload grows `stems[].recipes[]`; `machine.ts` types grow.
3. Review-screen UX: each stem row gains **"hear it as a voice"** beside the existing stem
   preview (clear label distinction), and an opt-in A/B drill-down (two unlabeled players X/Y,
   "sounds more like the speaker" vote, chosen recipe stored in reducer + sent on commit as
   `recipes: {emotion: recipe_id}`). Fast path stays one click; audition is never mandatory.
Service tests: stub engine (fake_engine), prove scratch isolation (roster meta untouched,
cleanup on error), recipe determinism. Web: machine reducer tests per existing convention.

### SIGNAL — Signal Layer (web) — proposal `ui-design-system.md` M1, steps 1–5 (6 optional)
1. Token unification: `tokens.ts` → CSS vars via `<GravitoneTokens>` in `layout.tsx`;
   `globals.css` + `StudioDark.tsx` consume vars; zero visual change (before/after parity).
2. `components/ui/AudioBus.tsx`: one AudioContext + AnalyserNode, ONE rAF writer setting C4
   vars on a scoped node; `register(mediaEl)`/`registerStream(stream)`; lazy resume on user
   gesture; **must route registered elements to destination** (createMediaElementSource
   silences otherwise — test this); degrade to keyframe mode, never throw.
3. `Waveform`/`Equalizer` read `--gt-level`/`--gt-peak` via transform when a source is
   registered; keyframe fallback preserved; reduced-motion → static peak bars.
4. `<TakePlayer>` primitive (Obsidian transport, registered audio, `{src, hue?, compact?}`);
   replace raw `<audio controls>` in `HeroMicDemo` + `GuidedRecorder`; register the playground's
   `useAudioPlayer` element with the bus (minimal edit).
5. Ambient: AppFrame aurora + cta-glow read `--gt-level`; `--gt-hue` from active character hue;
   `GeneratedGlyph` drop-shadow reads the vars.
Tests: vitest for token emission, bus lifecycle (mock AudioContext), TakePlayer render/keyboard.

## 6. Gates (every builder, before reporting)

- Service builders: `PYTHONIOENCODING=utf-8 python -m unittest service.tests.<your modules>` —
  and also `test_registry_invariants`, `test_ingest_truth`, `test_private_surface` (they catch
  cross-cutting contract breaks). `python -m py_compile` on every touched file.
  pytest does NOT exist here. torch/sherpa are NOT importable outside the test shims.
- Web builders: `npx tsc --noEmit` clean; `npx vitest run` green (full); do NOT run `next build`
  (orchestrator runs it once at integration).
- NO git commands. NO edits outside your ownership set. ASCII-safe console output (cp1252 box).

## 7. Report format (each builder writes + replies)

Write `docs/harness/moonshot-2026-07-30/batch1/REPORT-<agent>.md`: files created/modified,
contracts implemented (C1–C6 refs), hooks required from others (exact code), test evidence
(module → counts), UX decisions + how they follow §2, deferred sub-steps. Reply <150 words:
status, files touched count, tests green y/n, hooks needed y/n.
