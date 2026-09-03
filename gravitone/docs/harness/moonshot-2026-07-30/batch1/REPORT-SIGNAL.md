# REPORT — SIGNAL (Signal Layer), Batch 1

> Saved by the orchestrator from the builder's inline report (harness blocks subagent .md report writes).

**Status: complete.** `npx tsc --noEmit` clean; `npx vitest run` 309/309 green, 30 files (+39 tests
in 4 new files; no existing test modified). 17 files touched (8 new, 9 modified), all inside §4 SIGNAL.

Done:
1. `tokens.ts` is now the only home of Obsidian literals → `<GravitoneTokens>` emits `:root` `--gt-*`;
   `globals.css` + `StudioDark` consume them; parity pinned by tests (`makeRise()` reproduces
   StudioDark's 24/0.7/0.08 preset exactly) — zero pixel change.
2. `AudioBus.tsx` per C4: one ctx/analyser/rAF writer on a `display:contents` scoped node; elements
   routed to destination FIRST (tested), mic tapped only, analyser drained via zero-gain sink;
   degrades, never throws.
3. `EqBars` shared by Equalizer+Waveform: keyframe fallback preserved, live `scaleY` off
   level/centroid/peak; reduced motion = static peak at bus level.
4. `<TakePlayer>` (keyboard slider, aria, no chrome) replaces HeroMicDemo's `<audio controls>`;
   `useAudioPlayer` registered in one line.
5. Aurora / cta-glow / GeneratedGlyph read the channels; `--gt-working` shipped.

Hooks needed (all optional, nothing blocked):
1. GuidedRecorder (`web/app/voices/[characterId]/_variants/GuidedRecorder.tsx`, F-LEDGER's file)
   line ~184: replace `<audio src={previewUrl} controls className="h-9 max-w-[240px]" />` with
   `<TakePlayer src={previewUrl} compact hue={meta.hue} label={\`${meta.label} preview\`} className="max-w-[260px]" />`.
   Last raw `<audio controls>` in the app.
2. `useSignalHue(hue)` / `useSignalWorking(busy)` from `@/components/ui/AudioBus` — one line in
   character page / EmotionPicker / audition to tint + lean the frame.
3. AUDITION's A/B players should use `<TakePlayer label="X"|"Y">`.

Cascade gotcha for integration: unlayered CSS in globals.css outranks Tailwind's layered utilities —
the cta-glow reader uses a pseudo-element `opacity` instead of `filter` to avoid killing
`hover:brightness-110`.
