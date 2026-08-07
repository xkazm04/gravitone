# Gravitone web — the Signal design language

> Codified 2026-08-07, after the landing's feature-spotlight prototyping round
> ("steps · signal · stage") ended with the owner's verdict: **Signal wins,
> everywhere.** This document is what future sessions build within. It is not a
> style guide for one page — it is the house language.

## The one-sentence law

**The picture carries the story; text is secondary.** If a surface explains a
mechanism, the explanation is an animated illustration — waves, paths, pulses
composing the concept — and prose is demoted to one caption. If you find
yourself writing step-by-step rows of copy with icons, you are building the
thing this language replaced.

## Why "Signal"

Gravitone's product IS audio: waveforms, streams, turns, cuts. The house
illustration language draws every mechanism in that native medium — a request
is a path, a payload is a wave, an event is a pulse travelling, a boundary is a
line a signal turns back from. The metaphor is never decoration; it is the
product's own physics made visible.

## The vocabulary (use it, never fork it)

`components/variants/features/previews/illus.tsx` is the single shared
vocabulary. Compose from it; extend it (with a test) only when a primitive is
genuinely missing — a second parallel vocabulary is the failure mode.

- `Illus` — the canvas. Fixed viewBox, fluid on screen, `aria-hidden`,
  height budget ≤ 380 user units.
- `Draw` — a path drawing itself (`pathLength` dash-draw). The default verb.
- `TravelPulse` — a dot riding a path's exact geometry. Events travel.
- `WaveLine` — parametric waveform, morphable (`morphTo` must share `points`).
  Waves are made with `wavePath()`, damped to the midline at both ends so a
  segment boundary reads as silence.
- `Label` (≤ 3 words) · `Node` — the only in-picture annotations.
- `Caption` — **the one line of prose.** Two captions in one illustration means
  the drawing is not carrying the story: fix the drawing.

## Color discipline

- Hairline near-monochrome (`HAIR`, white at low alpha) plus **ONE accent per
  illustration.** The accent is the concept: the new route, the interruption,
  the boundary acting. Everything that is not the point stays hairline.
- Breaking the one-accent rule requires the CastSignal standard: color IS the
  concept (speaker identity), and everything else goes hairline to compensate.
  Say so in a comment.
- Color literals live in `components/ui/tokens.ts` and nowhere else
  (`accentVar()` / `--gt-*` in compositions). `tokens.test.ts` pins them — a
  token change is a deliberate, tested act.

## Honesty is drawn, not footnoted

The claims discipline (`lib/content.ts:61-94`, `lib/switchkit.ts`) extends into
the pictures:

- A limit is part of the illustration: mp3-can't-stream is a lane arriving as
  one block with a to-scale caliper on the gap; the missing emotion is the
  region that visibly does NOT morph; replica scaling shows the measured
  shortfall, not the linear fantasy.
- **To scale, from source.** When a picture encodes a number, compute the
  geometry from the source of truth (`lib/benchmarks.ts`, `lib/switchkit.ts`)
  so a re-measured run moves the drawing. Never retype figures into SVG.
- A changed thing is **struck in place**, never deleted — deleting says "that
  never existed"; what happened is one thing changed.

## Motion rules

- **Entrance-only, never infinite.** Stories run once per open/scroll-into-view
  (keyed remount replays them); ambient loops must pause offscreen
  (`usePauseOffscreen`). This is the `lighter-shell` law and it survives Signal.
- Pacing: a story reaches its caption in **≤ ~3 seconds**. Springs use the house
  `EASE`/bounce vocabulary (`tokens.ts`, `pop`/`stamp` from previews/shared).
- **Reduced motion: gate the animation, never drop the element.** Read the
  preference once via `lib/useStillMotion` (SSR-safe — framer's hook lies to
  the server) and pass `still` down. A stilled illustration is the END of its
  story, complete. Tests sweep stilled renders for thinness; keep them.

## Layout & chrome (unchanged by Signal, restated so it travels)

- Three fonts only: Instrument Serif (display), Hanken Grotesk (body),
  JetBrains Mono (labels/meta). Never a fourth.
- `glass-panel` + hairline borders on `--gt-ink`; the aurora is the page's
  atmosphere, not a component's.
- Content column `max-w-6xl px-6`; section rhythm `py-14`/`mt-8`; panels `p-5`.
  The voices/playground spacing pass (ec0563e) is the reference.
- Modals: click to open, Escape/scrim/button to close, one gesture each way.
  Content is designed to FIT (`max-h-[85vh]` at 1280×800); `.scroll-y`/`.scroll-x`
  are the emergency net, not the plan. Affordance is a quiet symbol
  (expand glyph), never a "click here" caption.
- Icons: lucide-react via `EmotionIcon`-style wrappers — shape from the pack,
  hue LIFTED to readable luminance (≥ 3:1 on ink). Generated sigil art is the
  ≥ 48px emblem, never the icon.

## Where Signal applies — and where it doesn't

**Yes** (illustration-first): landing sections, feature/mechanism explanations,
empty states that teach ("no takes yet" can draw what a take is), onboarding
moments, section-scale loaders, the pricing story, docs-adjacent explainers.

**Restrained** (Signal accents only — a drawn hairline, a pulse on completion,
a dash-draw on first render): dense working tools — the playground console,
casting board, keys table, ops. A tool the user operates eight hours a day must
not perform; it may *speak Signal* in its transitions and states without
becoming an illustration.

**No**: never let an illustration replace a truthful number a user needs to
read (tables/meters stay tables/meters, with the `<details>` accessible
fallback pattern); never animate during text entry or audio playback where it
competes with the content itself.

## Scale to the frame (owner correction, 2026-08-07)

Signal's philosophy does not shrink-wrap. The spotlight vocabulary (dense
hairline miniatures, micro-labels, calipers) fits a **modal-sized** frame a
user deliberately opened. A **section-scale** band on the landing is a
different frame and takes the philosophy, not the techniques: ONE story, drawn
big — full content width, generous height, two or three shapes, few and large
labels, whitespace as part of the design. The first Signal pricing section
failed exactly this way: a 680-unit two-panel miniature with 8px label
clusters, correct in every rule and wrong in the frame. Ask before composing:
*is this a picture the user leans into (modal) or one that must read at a
glance mid-scroll (band)?* Compose for that distance.

## Anti-patterns (each earned its place here)

- Step-by-step text rows with icons as "diagrams" — the thing Signal replaced.
- Sticker-tilt / static rotation on dark glass — aliases hairlines over
  backdrop-filter; reads as a rendering fault (rejected with reasons, 622591e).
- Two captions; labels over 3 words; prose doing the picture's job.
- Color as decoration; more than one accent without the CastSignal defense.
- Infinite ambient motion; animation that re-runs on every re-render;
  `useReducedMotion` from framer in anything the server renders.
- Retyped figures in SVG; a drawn comparison without its stated assumption.

## For future sessions

1. Read this file before touching any `gravitone/web` UI.
2. New mechanism to explain? Compose it from `illus.tsx` in the Signal rules
   above. The 8 landing spotlights (`*Signal.tsx`) are the reference corpus.
3. New functional surface? Take the restrained tier: house chrome + Signal
   accents in states and transitions.
4. If a design decision here blocks something genuinely better, change this
   FILE in the same commit that breaks the rule — an undocumented exception is
   how languages rot.

## Restrained-tier application log

What the restrained tier actually looks like, surface by surface, so the next
session copies a precedent instead of inventing a second dialect. Each entry
names what was applied — and the candidates that were deliberately LEFT ALONE,
because in this tier a skip is a design decision too.

### Playground (`app/playground/**`) — 2026-08-07

All accents live in one module, `app/playground/_variants/signal.tsx`, composed
from `previews/illus.tsx`. `still` is resolved ONCE in `PlaygroundConsole`
(`useStillMotion`) and passed down; no component in the playground reads the
preference for itself.

**Applied**

- **Empty take log** → `signal.tsx::EmptyTakes`. The flat hairline rail is the
  log's silence; the dashed cyan wave over it is the take that was never
  recorded (dashed = "route not taken", the vocabulary's own idiom). The
  existing sentence is unchanged and became the `<Caption>` — the copy is the
  caption now, not a second voice beside the drawing. h = 104.
- **Render-in-flight row** → `signal.tsx::RenderRail`, replacing 48 `.eq-bar`
  spans. Two reasons, and the second is the real one: the bars claimed to be
  levels while being a fixed keyframe, and `prefers-reduced-motion` (globals.css
  kills every CSS animation) froze them into a solid block of 48 full-height
  bars — the exact failure the "gate the animation, never drop the element" rule
  exists to prevent. A dash-draw of the wave being written has an honest still
  frame by construction. This is the ONE loop in the playground: a loader idles
  by definition, so it pauses offscreen (`usePauseOffscreen`) and stops dead
  under `still`. Every measured number on that row (elapsed, streamed seconds,
  queue depth, staleness) is untouched.
- **A take arriving** → `signal.tsx::TakeArrival`. One accent hairline across
  the top of the newest card, drawn once on mount. The completion is already
  announced in text and in the log's order; this is the visual sibling, spent on
  a single stroke. It is rendered for `takes[0]` ONLY — a marker that every card
  carried would be chrome, and would be saying "this just arrived" about takes
  that did not. `pointer-events-none`, so it can never eat a click on the card
  it marks.

**Skipped, with reasons**

- **`ScoreEditor`'s "No direction yet" line and its director's answer.** Both
  sit inside the direction panel, millimetres from controls the user works
  continuously, and the second is a live-region answer that changes on every
  press. A drawing there is a performing illustration next to a control — the
  thing the restrained tier exists to forbid.
- **Script mode with no lines.** Unreachable: `removeLine` is disabled at one
  line, so the surface has no empty state to teach.
- **Section headers and dividers.** Audited, not touched — `border-white/8` +
  uppercase mono `text-[11px]` already IS the landing's hairline/mono idiom.
  Aligning them would have been a diff with no perceptual change.
- **A sweep on an applied emotion region.** `ScoreText` paints its highlights
  through a mirrored overlay measured against a live textarea, and the region is
  applied WHILE the caret is in that text. DESIGN.md's own "No" clause covers
  it: never animate during text entry. The `score-applied` live region and the
  span lighting up remain the announcement.

**Test posture.** `signal.test.tsx` asserts the property that cannot be
eyeballed and silently rots: the stilled render is the COMPLETE drawing — same
`d` set, no dash offset held back, labels and caption already readable. Copy
that shape for the next surface.

### voices — 2026-08-07

**Applied**

- `app/voices/new/_loaders/StepRail.tsx` (new, in `WaveformLab`) — the ingest
  pipeline drawn as one line, one segment per backend step. Active step in the
  accent with a single travelling pulse; done steps settle to hairline; pending
  steps are the dashed route not taken. Every segment's `<Draw>` is keyed on
  `${key}:${state}`, so a step draws exactly once, at the moment it changes.
  Semantics untouched: the keys, labels and states are the backend's own
  (`service/ingest.py`), the SVG is aria-hidden, and the labels are rendered as
  an `<ol>` underneath with each state named in words — a reader who never sees
  the rail gets the same list.
- `app/voices/_variants/RosterEmpty.tsx` (new, in `CharacterTable`) — the
  full-tier empty state for a roster with no Characters at all: a recording (one
  wave) fanning into an emotion scale where the baseline slot is drawn solid in
  the accent and the rest are the dashed fallback, which is the same grammar
  `CoverageBar` uses one row down. h = 110. The roster's existing sentence is
  passed in as the `<Caption>` — the component authors no prose.
- `app/voices/new/_signal/SelectionSweep.tsx` (new, in the casting board) — one
  accent hairline drawing itself along a speaker row's base when that speaker is
  ticked into the cast. Entrance-only by construction (the element exists only
  while selected), `pointer-events-none`, and everything else on the row — play
  button, seconds, utterance count, sample text, "Review this →" — is byte-for-
  byte unchanged.
- `vitest.setup.ts` — a default `window.matchMedia`. jsdom implements none, so
  `useStillMotion` (which DESIGN.md requires on every drawn surface) crashed any
  test that merely rendered a tree containing an illustration. The default is
  the server's own answer, "motion is fine"; a test asserting the reduced-motion
  branch still stubs it for itself.

**Deliberately skipped**

- **"No characters match."** — a filter result over a roster that exists is not
  an empty state; a drawing there would be decoration next to data the user is
  actively narrowing.
- **The failed-read row** ("The character roster could not be loaded…") — a
  failure surface is prose plus a retry. Teaching what a Character is, at the
  moment we cannot say whether the user has any, would be answering a question
  nobody asked.
- **The `eq-bar` waveform in `WaveformLab`** — left exactly as it is. It already
  IS the product's own medium, it is the surface's liveness signal, and
  re-drawing it in `illus.tsx` primitives would have been a rewrite of working
  geometry for no gain.
- **Per-speaker play buttons / stats on the casting board** — a working tool
  must not perform (restrained tier). The accent went on the state that changes,
  and nowhere else.
