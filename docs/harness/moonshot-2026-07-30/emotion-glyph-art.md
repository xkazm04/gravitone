# Moonshots — Emotion Glyph Art & Brand (web)

Context scanned (read-only): `web/lib/glyphs/index.ts`, `web/lib/glyphs/generate.ts`,
`web/lib/emotions.ts`, `web/components/ui/EmotionArt.tsx`,
`web/components/ui/GeneratedGlyph.tsx`, consumers in `app/playground/_variants/`,
`app/voices/**`, `app/t/[id]/TakeCard.tsx`, plus `docs/harness/followups-2026-07-10.md`.

Current state: eight base emotions render baked PNG line-art (`public/emotions/*.png`,
`mix-blend-screen`); any *other* emotion id gets a procedural sigil whose entire
identity — blade count, length, width, curve, twist, hue — is derived from
`FNV-1a(name)`. The glyph therefore encodes **the spelling of a word** and nothing
about the voice or the emotion. Both moonshots below attack that: make the glyph
carry real information.

---

## M1. Voiceprint Sigils — the glyph is derived from the voice embedding, and becomes a public identity API

- **Tier**: 1 (10x category-defining)
- **Category**: platform
- **Impact**: Every Voice (speaker × emotion) gains a unique, deterministic visual
  fingerprint computed from its actual embedding, so a Character's "happy" looks
  visibly unlike anyone else's — and that fingerprint ships as a public
  `/v1/voices/{id}/sigil.svg` asset every customer app can render.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: it converts a decorative placeholder into the platform's
  identity primitive. A glyph that is a projection of the embedding means visual
  similarity ≈ vector similarity: users can *see* that a re-clone drifted, that two
  slots were recorded from the same take, or that a pack's voice is not the one it
  claims to be — provenance by eyeball, no tooling. And because the derivation is
  pure and deterministic, the same sigil renders identically in the studio, on share
  pages, in `.gravichar` pack covers, and inside third-party integrations, which is
  how a visual standard (and an ecosystem) starts.
- **Path to implementation**:
  1. In the current scaffold: generalize `generateGlyph(emotion)` to
     `generateGlyph(emotion, seedVector?: number[])` — keep FNV-1a name-hash as the
     degenerate zero-feature case (identical output today, zero regressions), but
     drive `blades/len/width/curve/twist/innerRing` from the first N features when
     supplied. Add a unit-style snapshot check that name-only output is byte-stable.
  2. Define a tiny stable digest of an embedding in the service: L2-normalize, fixed
     random-projection (seeded constant) to ~16 floats, quantized. Expose it as
     `fingerprint: number[]` on the existing voice/character metadata response — it
     is lossy and non-invertible, so it is safe to publish.
  3. Web: thread the fingerprint through `emotionMeta`/`EmotionArt` so a Voice with a
     known fingerprint renders its voiceprint sigil and an unrecorded slot renders
     the name-seeded sigil (dim). The rack instantly reads as "recorded vs empty"
     without a badge.
  4. Derive hue from the *speaker* component and geometry from the *emotion*
     component, so one Character's whole rack shares a family colour while each
     emotion keeps its own shape — a Character silhouette emerges for free.
  5. Ship `GET /v1/voices/{id}/sigil.svg?size=&hue=` (server-rendered from the same
     pure function, no React) as the public embeddable asset; use it for pack covers
     and share-page images.
  6. Add a "compare" view: two sigils overlaid + a scalar distance, used after
     re-clone and on pack import as a visual integrity check.
- **Dependencies**: read access to a stable per-Voice embedding + a place to hang the
  fingerprint on the metadata response; the pure-function refactor of `generate.ts`;
  an SVG-to-response path in the service (or a Next route) for the public asset.
- **Risks**: embedding format churn changes every sigil (mitigate by versioning the
  projection: `sigil_v1`, and freezing the seed constant); privacy optics of
  publishing anything derived from a voice (mitigate with the lossy quantized
  projection + doc note); visual quality — projections can produce ugly or
  near-identical shapes, so the parameter mapping needs perceptual spread, not raw
  linear mapping.
- **What changes if we ship it**: emotion art stops being decoration and becomes the
  platform's identity and integrity surface — the thing customers embed, and the
  fastest way to see that a voice is the voice it claims to be.

---

## M2. An emotion coordinate space — one source of truth behind hue, geometry, direction scripts, and nearest-emotion fallback

- **Tier**: 2 (3-5x)
- **Category**: functionality
- **Impact**: Replace `hue = hash(name) % 360` with real coordinates (valence,
  arousal, intensity) for every emotion — base and user-invented — so the visual
  system becomes *legible* (similar emotions look similar) and the same coordinates
  drive recorder direction, blending, and a nearest-neighbour fallback instead of
  today's always-drop-to-baseline.
- **Feasibility**: high
- **Time-horizon**: weeks
- **Why it's a moonshot**: it turns an arbitrary hash into a semantic model of the
  product's core noun. Today "furious" can land teal and "serene" scarlet, and a
  Character lacking `angry` falls all the way back to flat baseline — both are
  losses of meaning. With coordinates, art, copy, elicitation and synthesis fallback
  all derive from one small table, and every future emotion feature (interpolating
  between two emotions, intensity dials, "warmer/colder" browsing of a rack) becomes
  a lookup in a space that already exists rather than a new subsystem.
- **Path to implementation**:
  1. In the current scaffold: extend `EmotionMeta` in `lib/emotions.ts` with
     `coords: { valence: number; arousal: number; intensity: number }`, hand-authored
     for the eight base emotions, and derive `hue` from valence/arousal (a documented
     mapping) — verifying the eight shipped hues stay close enough that the baked
     PNGs still read correctly, pinning any that must not move.
  2. For custom emotions, resolve coordinates via an offline-bakeable lexicon
     (a JSON of ~200 common emotion words → coordinates, checked in) with the
     existing name-hash as the last-resort fallback for truly unknown words. Pure,
     offline, no keys — same guarantee `generate.ts` makes today.
  3. Feed coordinates into `generateGlyph`: arousal → blade count/length, valence →
     curve (blade ↔ petal), intensity → stroke weight and glow. Sibling emotions now
     visibly rhyme; opposites visibly clash. Keep the FNV seed only as per-name
     jitter so two synonyms are still distinguishable.
  4. Reuse the same coordinates in `lib/emotionScripts` so a custom slot gets a
     direction generated from its position ("high arousal, negative valence — clipped
     and forceful") instead of the generic "read in a strongly X tone".
  5. Expose `nearestEmotion(id, available[])` from this module and let the service's
     fallback resolve to the closest *available* Voice, with baseline as the final
     floor — a coverage-quality win that costs no new recordings.
  6. Add a small internal "emotion space" map page plotting every emotion's sigil at
     its coordinates; it doubles as the visual regression check for step 3.
- **Dependencies**: agreement on the hue mapping (may nudge existing base hues,
  which the baked PNGs are tinted against); the checked-in lexicon; service-side
  consumption for step 5 (steps 1–4 are web-only and independently shippable).
- **Risks**: hand-authored coordinates are subjective — needs one deliberate pass and
  then freezing; the lexicon will miss invented names like `battle_cry` (accepted:
  hash fallback); changing hues touches every screen that tints art, so it wants a
  visual sweep; scope creep into synthesis-parameter control, which is explicitly
  out of scope here.
- **What changes if we ship it**: the emotion scale stops being eight hardcoded rows
  plus a hash and becomes a continuous space — the brand reads as a system, and
  custom emotions inherit meaning instead of randomness.
