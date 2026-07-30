# Moonshot scan — UI Design System (web)

Context: `web/components/ui/` (`AppFrame.tsx`, `Primitives.tsx`, `tokens.ts`, `Equalizer.tsx`,
`EmotionArt.tsx`, `GeneratedGlyph.tsx`), `web/components/variants/StudioDark.tsx`,
`web/app/globals.css`, plus the consumers that reveal what the system does NOT yet provide
(`app/playground/_variants/PlaygroundConsole.tsx` + `useAudioPlayer.ts`,
`components/variants/HeroMicDemo.tsx`, `app/voices/**`).

Grounding observations (facts the proposals build on):

- The design language is declared in **three places that already drift**: `tokens.ts`
  (`SURFACE`, `EASE`, `rise`, `ACCENT` hexes), `globals.css` (`.glass-panel`, `.text-aurora`,
  `.cta-glow`, `@keyframes eq` — same values, hand-copied), and inline in `StudioDark.tsx`
  (its own local `ease`/`rise`, its own eyebrow pill markup that `Primitives.Eyebrow` already
  is). There is no CSS-variable layer at all; every color is a literal.
- Every "audio" visual in the system is **decorative fiction**. `Equalizer`/`Waveform` are
  `aria-hidden` bars on a fixed 1.1s CSS keyframe with `i % 9` phase offsets — they animate
  identically whether audio is silent, playing, or still generating. There is no
  `AudioContext`, `AnalyserNode`, or `decodeAudioData` anywhere in `web/` source.
- Playback itself is un-systematised: `HeroMicDemo` and `GuidedRecorder` drop a raw
  `<audio controls>` (browser-chrome grey, alien to Obsidian), while the playground rolls a
  private `useAudioPlayer` that tracks `currentTime/duration` as a scalar `progress` — no
  waveform, no seek target, no per-segment structure.
- The product's core artifact is **timed and structured**, and nothing in the primitive layer
  models that: `composerStore` holds `ScriptLine[]` (multi-character scripts) plus an
  `Expression` knob set, and the shipped emotion-addressing API takes inline `[tag]` spans —
  yet the UI renders a script as a list of textboxes and a take as one opaque blob.

---

## M1. The Signal Layer — one audio-reactive token bus every primitive breathes on

- **Tier**: 1 (10x category-defining)
- **Category**: platform
- **Impact**: Turns a static glass theme into an instrument panel wired to real sound: every
  surface, glow, and bar in the studio reacts to the actual amplitude, pitch and emotion of the
  voice being generated or played, from one shared source, at zero per-component cost.
- **Feasibility**: high
- **Time-horizon**: weeks
- **Why it's a moonshot**: Voice tools all look like text tools with a play button bolted on —
  including this one today, where the equalizer is a lie on a CSS timer and half the surfaces
  fall back to native `<audio>` chrome. Shipping a *design system* whose tokens are live signals
  rather than constants means the interface itself becomes evidence of the model running: the
  aurora leans into the voice's hue, the wordmark pulses on real speech, panels tighten while a
  clone is synthesising. That is a visual identity no competitor can copy by copying a palette,
  because it is architectural — one `AudioBus` writing CSS custom properties on a single rAF
  loop, and 30+ components reading them for free.
- **Path to implementation**:
  1. **Collapse the three token sources into one machine-readable root.** Make `tokens.ts` emit
     the real values as CSS custom properties (`--gt-accent-cyan`, `--gt-surface-top`,
     `--gt-ease`, `--gt-eq-period`) via a `<GravitoneTokens>` style tag in `layout.tsx`; rewrite
     `.glass-panel`/`.text-aurora`/`.cta-glow`/`@keyframes eq` in `globals.css` to consume the
     vars, and delete `StudioDark`'s local `ease`/`rise` in favour of the exported ones. Nothing
     changes visually; everything becomes addressable at runtime. Doable today, ~1 file each.
  2. Add `components/ui/AudioBus.tsx`: a provider owning one `AudioContext`, an `AnalyserNode`
     chain, and a single `requestAnimationFrame` writer that sets `--gt-level` (RMS),
     `--gt-peak`, `--gt-centroid` (brightness) and `--gt-hue` on a scoped element. One writer,
     N readers — no React re-renders in the hot loop. `register(mediaEl)` /
     `registerStream(mediaStream)` so both playback and live mic capture feed it.
  3. Re-implement `Waveform`/`Equalizer` to read `--gt-level`/`--gt-peak` per band via
     `scaleY(calc(...))` and fall back to the existing keyframe when nothing is registered — so
     idle decoration is preserved and every existing call site upgrades untouched. Honour the
     existing `anim-paused` + `prefers-reduced-motion` contracts (reduced motion → static bars
     driven by peak only, no oscillation).
  4. Add the missing player primitive `<TakePlayer>` (Obsidian-styled transport + registered
     `<audio>`) and swap out the raw `<audio controls>` in `HeroMicDemo` and `GuidedRecorder`,
     and the private transport in `useAudioPlayer`. This is the moment the system stops leaking
     browser chrome.
  5. Wire ambient reaction: `AppFrame`'s aurora and the `cta-glow` intensity read `--gt-level`;
     `--gt-hue` is driven by the active Character's hue (already in `VOICES`/`emotionMeta`) so
     the whole frame tints per voice. `GeneratedGlyph`'s drop-shadow reads the same var, making
     procedural sigils pulse with their own emotion's audio.
  6. Add a `generating` signal channel (queue/stream state, not audio) so surfaces express
     "model is working" through the same bus instead of ad-hoc spinners.
- **Dependencies**: Web Audio API (universally available); existing `usePauseOffscreen`;
  `emotionMeta` hues; `next/font` var plumbing already in `layout.tsx`. Same-origin or CORS-clean
  audio URLs for `createMediaElementSource` (takes are served from our own service — fine).
- **Risks**: (a) `AudioContext` requires a user gesture — bus must lazily resume and degrade to
  keyframe mode, never throw; (b) `createMediaElementSource` hijacks an element's output, so
  every registered element must route through the bus's destination or it goes silent — needs a
  test; (c) rAF writing CSS vars on a high element can trigger wide style recalc — write to a
  single scoped node and keep readers on `transform`/`opacity`/`filter` only; (d) motion-
  sensitivity regressions if reduced-motion isn't wired at the bus level too.
- **What changes if we ship it**: Gravitone's UI becomes the demo — the studio visibly, honestly
  reacts to the model it runs on, and any new module gets that for free by using the primitives.

---

## M2. Score view — a timeline/region primitive grammar that makes emotion directly editable

- **Tier**: 1 (10x category-defining)
- **Category**: functionality
- **Impact**: Promotes the shipped emotion-addressing tag grammar and multi-character scripts
  from strings in a textarea to first-class, draggable UI objects on a shared timeline
  primitive — so directing a performance becomes a visual act instead of remembering `[tag]`
  syntax.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: The engine already accepts inline emotion spans and per-line
  characters, but the design system has no vocabulary for *time* or *span* — a take is one
  `<audio>` blob and a script is a stack of textboxes, so the most expressive capability in the
  product is invisible unless you read the API docs. A `Track / Region / Playhead / Rail`
  primitive set — styled in Obsidian glass, coloured by each Character's hue and each emotion's
  sigil — turns text into a score: select words, drop a `[whisper]` region, drag its edges, hear
  only that region, stack character lanes for a scene. That's a category jump from "TTS box" to
  "performance editor", and it makes every future engine capability (pacing, pauses, pitch
  targets) expressible without new UI thinking.
- **Path to implementation**:
  1. **Add `components/ui/Track.tsx` today as a pure presentational primitive**: fixed-height
     glass rail + `<Playhead>` bound to the `progress` scalar `useAudioPlayer` already returns,
     plus peak bars reused from `Waveform`. Drop it into the playground under the existing
     transport — a real, immediately visible upgrade with zero data-model change.
  2. Give it real peaks: decode the returned WAV once (`decodeAudioData` → min/max buckets) into
     a `peaks: Float32Array` memo, cached beside the take in `playgroundDb`. Click-to-seek and
     drag-scrub now mean something. (Shares the `AudioContext` with M1's bus if that lands.)
  3. Introduce `<Region>` + a `regions` model in `shared.ts`: `{ start, end, kind: 'emotion',
     value }` expressed over **character offsets in the text**, with pure `toTags()` /
     `parseTags()` functions bridging to the existing inline `[tag]` string — the API contract is
     unchanged, the string becomes a serialisation format. Unit-test the round-trip both ways
     (the repo's `*.test.ts` convention next to `composerStore.test.ts`).
  4. Build `<ScoreEditor>`: the text as the horizontal axis with emotion regions rendered
     beneath it, each tinted by `emotionMeta(...).hue` and badged with `EmotionArt`/
     `GeneratedGlyph`. Selection → "add region"; drag edges to resize; region click → solo
     preview of just that span.
  5. Stack lanes for `ScriptLine[]`: one `<Track>` per character line, tinted by Character hue,
     sequenced vertically — the multi-character script becomes a readable scene, and
     `composerStore` gains `regions` (with `sanitizeComposer` validation and clamping, same
     defensive style as the existing sanitizer).
  6. Export the primitive set from the design system and reuse it on the takes/review surfaces so
     a shared take shows the same score, not a bare player.
- **Dependencies**: existing tag grammar + emotion registry (`lib/emotions.ts`,
  `emotionScripts.ts`); `composerStore` schema bump + sanitizer; `playgroundDb` for peak cache;
  `decodeAudioData`. Benefits from M1's `AudioBus` but does not require it.
- **Risks**: (a) offset-based regions are fragile under text edits — need an edit-transform pass
  or regions silently drift onto wrong words; (b) drag interactions must stay keyboard- and
  touch-operable or the feature is exclusionary (arrow-key nudge + numeric fields as the
  accessible path); (c) `PlaygroundConsole.tsx` is already 1510 lines — the score editor must
  land as its own component tree, not more console; (d) decoding long takes on the main thread
  janks — bucket in a worker or chunk with `scheduler.yield`; (e) scope creep toward a full DAW —
  hold the line at regions over text, no arbitrary audio editing.
- **What changes if we ship it**: Emotion direction becomes discoverable and visual, and
  Gravitone reads as a performance tool that happens to have an API rather than an API with a
  form on top.
