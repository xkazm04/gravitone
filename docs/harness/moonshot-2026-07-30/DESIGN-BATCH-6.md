# Batch 6 Design — "Expression Frontier" (FINAL)

> Four features, one story: **expression stops being a recording chore.** Emotions become
> transferable vectors derived from the embeddings the roster already owns (Emotion/Voice
> Algebra — the merged idea), directing a performance becomes a visual act (Score View),
> the segment layer becomes visible and editable (Segment Casting Board), and synthesis
> learns to run in the browser itself (In-Browser Engine — scoped to its honest first step).
>
> Branch: `vibeman/moonshot-batch-1` (continues). Builders NEVER run git. All prior
> vocabulary binding. This is the riskiest batch by design — every feature has an explicit
> KILL-SWITCH step and an honest degrade.

## 1. Shared contracts

### H1. Algebra (service, owned by ALGEBRA)
Measurement gate FIRST: `service/tools/emotion_residuals.py` — load every voice embedding
(grouped by character/emotion via the registry), compute `(emotion − baseline)` residuals
per multi-slot speaker, report pairwise cosine of same-emotion residuals ACROSS speakers.
**This number decides everything.** Ship it as a tool + a test over synthetic fixtures with
KNOWN geometry (coherent + incoherent cases) so the math is proven even though real
embeddings need the Arm box. Then, gated on it: `service/emotion_basis.py` (averaged
per-emotion residuals → `voices/_basis.safetensors` + `_basis.json` with per-emotion
coherence + calibrated α; regenerate on demand, never at request time);
`POST /v1/characters/{id}/emotions/{emotion}/derive` through create_voice's existing staging
discipline with registry `origin: "derived"`, `basis_version`, `confidence` (default origin
"recorded" everywhere else); `resolve()` rung: exact → derived → measured-prosody →
FALLBACK_CHAIN → baseline → deterministic (extends batch-1's measured mode; cold start
byte-identical); manifest splits performable into recorded/derived; demand keeps firing for
derived-only slots. Derived slots INHERIT the baseline's consent receipt and never claim
attestation. On this box (no torch): every embedding-touching path degrades named +
tests use synthetic tensors via the fake_engine shim pattern. Web half: EmotionRack's empty
slots gain `derive from…` (roster donor picker → the endpoint; 501-with-reason surfaces
honestly), derived slots badge `derived · from <donor>` (NEVER rendered as recorded) with
one-click promote-to-recording; rack files belong to ALGEBRA this batch.

### H2. Score primitives (web, owned by SCORE)
`components/ui/Track.tsx` (glass rail + Playhead bound to the player's progress, peaks via
existing Waveform/EqBars machinery), `<Region>` + `regions` model over CHARACTER OFFSETS in
text with pure `toTags()`/`parseTags()` bridging the existing inline `[tag]` grammar — the
string stays the API contract; round-trip unit-tested BOTH directions. `<ScoreEditor>`:
text as horizontal axis, emotion regions beneath tinted by emotionMeta hue + sigil badge,
selection → add region, drag + ARROW-KEY resize (keyboard path mandatory), region click →
solo preview of the span via /api/speak. Lands as its OWN component tree (PlaygroundConsole
is 1500+ lines — mount hook ≤10 lines, orchestrator applies). Regions must survive text
edits via an edit-transform pass or degrade to clearing the affected region with a named
notice — never silently drift onto wrong words. Multi-lane ScriptLine stacking optional.

### H3. Casting board (svc+web, owned by CASTING)
Service: per-segment labels already exist in job results (batch-1 exposed fidelity/outliers)
— add `GET /v1/ingest/{job}/segment/{i}` (sibling of speaker-preview) and
`POST /v1/ingest/{job}/stems {emotion: [segment indices]}` re-running concat_wavs and
returning per-stem seconds/eligibility (no roster writes; workdir-scoped; named refusals on
bad indices/committed jobs). Web (voices/new review screen): expand a ledger row into its
segments with play buttons (read-only step 1), then move/exclude segments with a debounced
re-splice — the seconds bar and eligible badge update live so a short stem can be WATCHED
crossing the 4s line; "reset to proposed" always visible; pairs with the existing audition
("re-splice then audition"). Cross-recording pooling is NOT this batch (corpus landed in
batch 5 — note the seam, don't build it).

### H4. Browser engine seam (web, owned by WASM)
The honest first step ONLY (full WASM port is a quarters-scale effort): a typed
`web/lib/engineSeam.ts` — `interface SpeechEngineClient { synthesize(req): Promise<TakeAudio>;
capabilities(): EngineCaps }` with the SERVER adapter as the only real implementation, the
playground/hero paths refactored to consume the seam, plus a `LocalEngineProbe` that
feature-detects (WebGPU/WASM-SIMD/threads/storage quota) and reports what a local engine
WOULD need — surfaced in a small diagnostics panel on /benchmarks ("your browser could run
a local engine: yes/no, missing: X"). NO model download, NO ONNX runtime this batch; the
seam + probe make the quarters-scale port a plug-in instead of a rewrite. Tests: seam
conformance for the server adapter, probe matrix with mocked capabilities.

## 2. File ownership (HARD)

| Agent | Owns | Must NOT touch |
|---|---|---|
| **ALGEBRA** | `service/tools/emotion_residuals.py`, `service/emotion_basis.py`, `service/voices.py`, `service/emotions.py`, their tests; `web/app/voices/[characterId]/**`, `web/app/api/characters/**` | `service/ingest*.py`, `service/app.py` (derive route lives on voices router), `web/app/voices/new/**`, `web/app/playground/**` |
| **SCORE** | `web/components/ui/Track.tsx` + Region/ScoreEditor files (new), `web/app/playground/_variants/shared.ts` (regions model + toTags/parseTags), colocated tests | `PlaygroundConsole.tsx` (mount diff in report), `engine.ts`, service/**, `web/app/voices/**` |
| **CASTING** | `service/ingest_api.py`, `service/ingest.py` (stems re-splice only — corpus layer landed batch 5, do not disturb), their tests; `web/app/voices/new/**` | `service/voices.py`, `service/export_stems.py`, `web/app/voices/*` outside new/, `web/app/playground/**` |
| **WASM** | `web/lib/engineSeam.ts` (new), `web/lib/engineProbe.ts` (new), `web/app/benchmarks/**` (diagnostics panel), `web/app/playground/_variants/engine.ts` + `web/components/variants/HeroMicDemo.tsx` (seam refactor only), colocated tests | service/**, `web/app/playground/_variants/PlaygroundConsole.tsx`, `web/app/voices/**` |

voices.py + emotions.py single owner: ALGEBRA. ingest single owner: CASTING. engine.ts
single owner: WASM (SCORE's regions live in shared.ts; orchestrator resolves any overlap).

## 3. Gates
Service: your modules + test_private_surface + test_registry_invariants +
test_emotion_fallback + all test_ingest_* (CASTING) + test_corpus (CASTING — batch-5 layer
must stay green) + test_fidelity (ALGEBRA) — green; py_compile. Web: tsc + full vitest
green except the tracked PlaygroundConsole load flake. NO git. ASCII. No torch outside
shims; synthetic tensors for all embedding math tests.

## 4. Reports
Reply <200 words: status/files/tests/hooks (+ SCORE's console mount diff; ALGEBRA's honest
answer on whether the residual gate can even run without real embeddings and what the Arm
box must do). Orchestrator persists under `batch6/`.
