# Moonshots — Character & Voice Management (web)

Context: `web/app/voices/**` (roster table, per-character emotion rack, ApiPanel recipes,
tag editor, `_data/characters.ts`) + `web/app/api/characters/**`, `web/app/api/voices/**`,
backed by `service/voices.py` (one embedding file per Voice, registry metadata beside it).

Scanned 2026-07-30. Both proposals build on what already exists: a Character = a group of
per-emotion embeddings, a slot model that tolerates duplicates, demand telemetry, consent
receipts, and a rack that already knows how to say "this slot falls back to baseline".

---

## M1. Voice Algebra — derive emotions and characters from embeddings the roster already owns

- **Tier**: 1 (10x category-defining)
- **Category**: platform
- **Impact**: Turns every recorded emotion in the roster into a reusable *emotion delta* that
  can fill the same slot on any other Character, so coverage stops being a per-character
  recording chore and becomes a roster-wide asset that compounds with each take.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: Today a Character's anger requires that speaker to perform anger;
  `EmotionRack` can only offer "record this" or "upload" for an empty slot, and the whole
  demand loop exists because those slots stay empty. If an emotion is representable as a
  vector offset in embedding space (`angry − baseline`), then one good angry take anywhere in
  the roster can be *applied* to every baseline in it — a genuine network effect inside a
  single-user install, and across installs via the existing `.gravichar` pack format. It
  reframes the product from "a cloning tool" to "a voice algebra": derive, blend, transplant.
- **Path to implementation**:
  1. **In the current scaffold**: add a third action to every empty slot in
     `EmotionRack.tsx` — `derive from…` — opening a picker over the roster
     (`loadRoster()` already gives every Character's filled emotions) that names candidate
     donors for that emotion. Wire it to a new `POST /api/characters/[id]/derive`
     proxy that, for now, 501s with the reason. This makes the missing capability visible and
     measurable before any DSP work.
  2. Prove the arithmetic offline: a `service/` script that loads two embeddings for the same
     speaker (baseline + one emotion), computes the delta, adds it to a *different* speaker's
     baseline, synthesizes, and A/B's the result against that speaker's real recording of the
     emotion. Ship the notebook-style findings as a go/no-go; the honest outcome may be
     "works for arousal-type emotions (excited, angry), fails for timbre-coupled ones".
  3. Land `derive_voice()` in `service/voices.py` beside `clone`: same staged-write /
     load-back-verify / registry-first discipline, but sourced from tensor math instead of the
     exporter. Emit a new provenance field (`derived_from: {donor_voice_id, method, weight}`)
     into the registry row.
  4. Surface derivation as a first-class, *distinguishable* state in the rack: a derived slot
     is not "recorded" — badge it `derived · from Mary's angry`, keep the demand counter alive
     for it, and let one click promote it to a real recording. Same discipline the codebase
     already applies to `shadowed · never spoken`.
  5. Extend to Character blending (`w·A + (1−w)·B` over the whole scale) as a second
     verb once single-slot derivation is trusted, exposed on the roster's selection bar for
     exactly two selected Characters.
  6. Carry `derived_from` through pack export/import and the Voice Vault so a derived voice
     can never launder away the consent receipt of the donor it came from.
- **Dependencies**: readable/writable embedding tensors from the Kyutai exporter (shape and
  semantics need confirming — step 2 is the gate); `service/voices.py` staged-write path;
  `lib/voiceVault` for derived-voice provenance; pack manifest version bump.
- **Risks**: the arithmetic may simply not hold in this embedding space (mitigated by making
  step 2 a cheap, early kill-switch); derived voices that sound *almost* right are worse than
  an honest baseline fallback, so the rack must never present derived as recorded; consent
  laundering — deriving from a donor voice must inherit the donor's consent constraints, not
  mint a fresh unencumbered voice.
- **What changes if we ship it**: A roster's 40 empty emotion slots fill in an afternoon
  instead of forty recording sessions, and every new take anyone records makes the entire
  roster better rather than one row of it.

---

## M2. Fidelity Ledger — every Voice carries a measured score, and the roster audits itself

- **Tier**: 2 (3-5x)
- **Category**: user_benefit
- **Impact**: Replaces "clone it and hope" with a measured, per-Voice fidelity/usability score
  computed locally at clone time, so a bad take is caught in the rack instead of by an API
  caller in production.
- **Feasibility**: high
- **Time-horizon**: weeks
- **Why it's a moonshot**: The rack today reports *presence* — recorded, sample seconds, voice
  id, a consent shield — and nothing about *quality*. Coverage is `8/8` whether those eight
  takes are studio-clean or clipped phone audio recorded next to a fan, and the only feedback
  channel is a user listening to previews one at a time. Because Gravitone is CPU-only and
  local-first, it can afford to measure what hosted vendors won't expose: speaker similarity
  to the character's own baseline, SNR, clipping, effective speech duration, and emotion
  separation from the neighbouring slots. That makes voice quality a number the product owns,
  and turns the roster into the first TTS surface that tells you *which of your voices is the
  weak one* before your users do.
- **Path to implementation**:
  1. **In the current scaffold**: add an optional `fidelity?: { score: number; flags: string[] }`
     to the `Voice` type in `web/app/voices/_data/characters.ts`, render it as a compact
     column in `EmotionRack` and fold a roster-level worst-slot indicator into `CoverageBar`
     in `CharacterTable.tsx`. It renders nothing when absent, so the UI ships ahead of the
     metric and every later step is purely additive.
  2. Compute the cheap, signal-only half at clone time in `service/voices.py`: peak/clipping
     ratio, noise floor, VAD-derived effective speech seconds (`service/vad.py` already
     exists), sample-rate adequacy. Store it on the registry row; expose it through
     `GET /v1/characters` and the `[id]` route.
  3. Add the model-side half: cosine similarity of this Voice's embedding against the
     Character's own baseline (identity drift — "this doesn't sound like the same person") and
     against sibling emotion slots (separation — "your angry and your excited are the same
     voice"). Both are one dot product over tensors already on disk.
  4. Make the number actionable rather than decorative: a `re-record this` affordance on any
     slot below threshold that opens `GuidedRecorder` pre-loaded with the specific defect
     ("clipped — move further from the mic"), and a roster sort key `weakest` next to the
     existing `demand` column so the user's next action is always one click from the table.
  5. Carry fidelity into `.gravichar` export and the `ApiPanel` manifest recipe, so a pack's
     quality is inspectable before import and API consumers can read it from
     `GET /v1/characters/{id}/manifest`.
- **Dependencies**: `service/vad.py`; embedding tensor reads (shared gate with M1 step 2 for
  the similarity half — the signal-only half needs nothing new); registry schema field +
  migration of existing rows to `fidelity: null` (absent must read as "not measured", never as
  "measured zero"); `lib/emotionScripts` for defect-specific recorder directions.
- **Risks**: a score that disagrees with what the user hears destroys trust in the whole
  surface — calibrate against a labelled set of deliberately bad takes before showing a number,
  and prefer named flags ("clipped", "8 kHz source", "1.4 s of speech") over a single opaque
  0-100; scoring must stay off the synthesis hot path (compute once at clone, never per
  request); thresholds are engine-specific and will need revisiting if the model changes.
- **What changes if we ship it**: The roster stops being an inventory and becomes a quality
  dashboard — the user knows which voice to re-record, and a shared Character Pack arrives with
  its fidelity legible instead of anecdotal.
