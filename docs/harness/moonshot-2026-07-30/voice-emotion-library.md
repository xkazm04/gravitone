# Moonshots — Voice & Emotion Library (2026-07-30)

Context files read: `service/emotions.py`, `service/voices.py`, plus
`service/demand.py`, `service/export_stems.py` surface, `service/dialog.py` header,
`docs/harness/followups-2026-07-10.md`.

Current shape of the context: a Voice is one `.safetensors` embedding = one speaker
in one emotion; a Character groups Voices across an 8-slot base scale plus declared
custom slots; `resolve()` maps a requested emotion to a voice_id through a
**hand-written 7-entry `FALLBACK_CHAIN`**, then baseline, then a deterministic pick.
Coverage is therefore linear in *recordings made by a human*, and the emotion label
on a slot is whatever the uploader typed — never measured.

Both proposals attack exactly those two structural limits.

---

## M1. Emotion Algebra — derive a Character's missing emotions from a shared emotion basis

- **Tier**: 1 (10x category-defining)
- **Category**: functionality
- **Impact**: Turns emotional range from "record 8 takes per person" into "record
  one take, get the whole palette". Every Character in every install jumps from
  typical coverage 1–3/8 to 8/8 without a microphone, and the coverage backlog that
  demand telemetry keeps generating becomes a one-click fill instead of a chore.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: The module docstring states the current law — "Pocket TTS
  has no emotion/style conditioner… an emotion is literally *a different recording of
  the same person*" — and the whole Character/slot model exists to work around it.
  This proposal breaks that law by treating expression as a **transferable direction
  in embedding space**: if `(angry − baseline)` residuals computed across the 26
  built-ins and every multi-slot cloned Character point the same way, that averaged
  residual is a portable emotion vector, and `baseline + α·vector` is a synthetic
  `angry` embedding for a speaker who never recorded one. Nobody ships
  parameterised emotion on a 100M CPU-only model; if the residuals cohere, Gravitone
  does — and it costs zero inference-time compute because the derived embedding is
  just another `.safetensors` on disk.
- **Path to implementation**:
  1. **Measurement gate, current scaffold, no product change.** Add
     `service/tools/emotion_residuals.py`: load every `.safetensors` in
     `VOICES_DIR` (grouped by `character_id`/`emotion` straight out of
     `_load_meta()`), and for each speaker with ≥2 slots compute
     `emotion − baseline`. Report pairwise cosine similarity of same-emotion
     residuals across *different* speakers. This single number decides whether M1
     is real. Ship it as a dev script + a test on the built-in corpus.
  2. **Basis derivation.** If residuals cohere, add `service/emotion_basis.py`:
     average per-emotion residuals into a basis persisted as
     `voices/_basis.safetensors` + `_basis.json` (contributing speakers, per-emotion
     cosine coherence, α scale calibrated by minimising distance to held-out real
     slots). Regenerate on demand, never at request time.
  3. **Derived Voices as a first-class, honest category.** `POST
     /v1/characters/{id}/emotions/{emotion}/derive` writes a real embedding through
     the existing staging discipline in `create_voice` (temp dir → `export_stems`
     load-back verification → `mutate_meta` slot re-check → `shutil.move`), with the
     registry row carrying `origin: "derived"`, `basis_version`, and `confidence`.
     `Voice` gains `origin` (default `"recorded"`), so every existing surface —
     roster, manifest, packs — reports what is real and what is inferred.
  4. **Resolution order.** `resolve()` gains a middle rung: exact native → **derived
     native** → `FALLBACK_CHAIN` neighbour → baseline. `character_manifest` splits
     `performable` into `recorded` / `derived` and keeps `missing` truthful.
     `demand.record_fallback` still fires for anything only derived, so appetite data
     stays honest.
  5. **Demand-driven autofill.** A background pass reads `all_demand()` and derives
     the hottest missing slot per Character automatically, capped and reversible
     (deleting a derived Voice is the same `_unlink_then_forget` path). The coverage
     loop stops asking the user for anything it can compute.
  6. **Quality bar.** Blind A/B harness: for held-out speakers that *do* have a real
     `angry`, synthesize the same line from real vs derived and score with the M2
     probe (below) plus a small human listen set. Publish per-emotion transfer
     quality in `_basis.json`; refuse to derive emotions below threshold.
- **Dependencies**: `export_stems` load-back verification (already the clone path's
  gate); embedding tensor shape/semantics stable across `quantize` settings;
  `.gravichar` pack format needs an `origin` field so derived slots travel labelled;
  enough multi-slot Characters in the built-in corpus to fit a basis (step 1 answers
  this — if not, bootstrap from a deliberate 3-speaker × 8-emotion recording session).
- **Risks**: **The residuals may simply not be linear or speaker-portable** — step 1
  is designed to kill the idea in a day rather than a quarter. Derived voices that
  sound like a *different person* (identity drift with large α) — mitigate by
  constraining α and rejecting on speaker-similarity regression. Trust risk: users
  must never believe a synthetic slot is their own recorded performance — hence
  `origin` on every surface and in packs. Consent posture: a derived slot inherits
  the baseline's consent receipt and must not claim independent attestation.
- **What changes if we ship it**: Emotional range stops being a function of the
  user's patience, and Gravitone gains the one capability a 100M CPU model is
  "supposed" to be unable to have — parameterised expression — while every competitor
  charges per additional voice recording.

---

## M2. Measured Emotion Space — a listener that hears what a voice actually is, and continuous emotion addressing

- **Tier**: 2 (3-5x)
- **Category**: feature
- **Impact**: Every slot's label becomes *verified* rather than *asserted*, and
  emotion becomes addressable as a **coordinate** (`[arousal=.8,valence=-.4]`, or any
  word resolved to its nearest measured point) instead of a member of a hand-written
  vocabulary — so custom emotions, cross-character direction and fallback all work
  without anyone extending a dict.
- **Feasibility**: high
- **Time-horizon**: weeks
- **Why it's a moonshot**: Today `FALLBACK_CHAIN` is seven human guesses about
  acoustic adjacency, hardcoded, empty for every custom emotion, and identical for
  every speaker — a `whisper` slot that was actually shouted still routes as quiet.
  Replacing it with **measured geometry per Character** flips the whole library from
  a naming convention into a metric space: nearest-neighbour fallback comes free,
  mislabelled slots get caught at clone time, and continuous coordinates give an API
  no named-preset TTS product can offer. It is cheap — F0/energy/rate/spectral-tilt
  prosody statistics over the already-loudnorm'd `clean.wav`, pure numpy, CPU-only,
  in keeping with the whole platform's thesis.
- **Path to implementation**:
  1. **Probe + backfill, current scaffold.** Add `service/prosody.py`:
     `probe(wav) -> {f0_mean, f0_sd, energy, rate_proxy, spectral_tilt, jitter}` from
     `wave` + numpy only. Wire it where the audio is *already in hand and about to be
     thrown away* — `create_voice` has `clean` in scope before staging, and the
     ingest commit path has its stems — and store the vector in the voice's meta row.
     For built-ins and pre-existing rows with no source audio, backfill by
     synthesizing one fixed calibration sentence through `engine.py` and probing the
     output. Purely additive; nothing reads it yet.
  2. **Calibrate to a 2-D affect plane.** Fit valence/arousal axes by regressing the
     probe vectors of all *labelled* base-scale slots across the corpus onto known
     positions (excited = high arousal/positive, whisper = low arousal/neutral, …),
     persisted as `voices/_affect.json`. Each Voice gains a `coords` pair; each
     Character gains a measured palette map. Report per-speaker normalisation so a
     naturally loud speaker isn't globally "angry".
  3. **Label verification at capture.** `create_voice` / the guided recorder compare
     the new slot's coords to its declared emotion's expected region and return a
     non-blocking `label_check: {agrees, nearest, distance}`. The studio can say
     "this reads closer to `calm` than `angry` — keep, or re-slot?" — a real quality
     gate on the one thing the system currently takes purely on faith.
  4. **Geometry replaces the chain.** `resolve()` gains a measured mode: on a miss,
     pick the available slot nearest the *requested* emotion's coordinate in this
     Character's own measured space; keep `FALLBACK_CHAIN` as the cold-start default
     when coords are absent, and keep `deterministic_fallback` as the final rung so
     behaviour stays deterministic and testable. Custom emotions now get sensible
     fallback with zero configuration — the single biggest gap in the current model.
  5. **Continuous addressing.** Extend the metatag grammar and the
     `{character}:{emotion}` address to accept coordinates
     (`[a=0.8,v=-0.3]`) and unknown *words* resolved by nearest measured point;
     `character_manifest` publishes each slot's coords plus the palette's convex hull
     so a client can see, before directing a script, exactly which emotional
     territory this Character can actually reach.
  6. **Coverage as area, not count.** Replace/augment `coverage: "3/8"` with the
     fraction of the affect plane the Character spans — which redirects recording
     effort toward *filling emotional gaps* rather than ticking off names.
- **Dependencies**: numpy (already in the service env); `clean_audio` output being
  the canonical probe input (it is, for both clone paths); `engine.py` synthesis for
  built-in backfill; `.gravichar` manifest gains `coords` so measured palettes travel
  with packs; M1 consumes this probe as its quality judge (nice, not required).
- **Risks**: Cheap prosody features are a *proxy* for perceived emotion — over-claim
  and the label check becomes an annoying wrong opinion, so it must stay advisory,
  never blocking, and be evaluated against the labelled corpus before it is turned
  on by default. Speaker-dependent baselines (loud/quiet, male/female F0 ranges)
  need per-speaker normalisation or the plane is mostly measuring the person.
  Coordinate addressing must degrade gracefully for clients that only know names —
  named addressing stays the primary contract.
- **What changes if we ship it**: The emotion library stops being a list of words
  someone typed and becomes a measured space — mislabels get caught, custom emotions
  get free fallback, and "give me somewhere between sad and calm, 30% of the way" is
  a request the API can actually answer.
