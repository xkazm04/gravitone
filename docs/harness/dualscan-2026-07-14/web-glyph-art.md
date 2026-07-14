# Dual-lens scan — web-glyph-art
> Files: 14 | Findings: 5 (crit 0 / high 0 / med 3 / low 2)
> Lenses: bug-hunter + code-refactor

## 1. Entire traced-glyph subsystem is built but never mounted
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: dead-code
- **File**: `web/components/ui/EmotionGlyph.tsx:14` (also `web/lib/glyphs/index.ts:19` + 8 data files)
- **Scenario**: `EmotionGlyph` is the only consumer of `GLYPHS`, and a repo-wide grep for `EmotionGlyph` matches exactly one file — its own definition. Nothing imports it. The live art path is `EmotionArt` → `<Image>` (base PNGs) or `EmotionArt` → `GeneratedGlyph` → `generate.ts` (custom sigils); the baked SVG glyphs are never rendered.
- **Root cause**: The motionize pipeline (`EmotionGlyph` + `GLYPHS` index + the 8 auto-generated `baseline/calm/happy/excited/sad/angry/whisper/confused.ts` files) was staged as the "future animated replacement" for the static PNGs (see `emotions.ts:10` "Trace-friendly for a future /motionize pass") but the swap into `EmotionArt` was never made.
- **Impact**: ~10 files (incl. large multi-KB path-data modules) ship in the bundle graph and carry maintenance cost while producing zero UI. Any bug in them (see findings 2 & 4) is invisible until wired, so it rots undetected.
- **Fix sketch**: Decide the roadmap explicitly — either wire `EmotionGlyph` into `EmotionArt` (replacing/augmenting the `<Image>` branch for base emotions) or delete the subsystem. Don't leave it half-connected. If kept, close findings 2 & 4 first.

## 2. `confused` glyph's full-canvas background rect is never stripped
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: silent-failure
- **File**: `web/lib/glyphs/index.ts:16` (data at `web/lib/glyphs/confused.ts:3`)
- **Scenario**: `strip()` drops the tracer's full-canvas rect only when `p.fill === "var(--background)"`. Every glyph emits that rect with `fill:"var(--background)"` — except `confused`, whose first path is `{"d":"M0 0h1024v1024H0z","fill":"#1A040D",...}` (a resolved hex, not the CSS var). The `&&` fails, so the rect survives into `GLYPHS.confused.paths`.
- **Root cause**: `strip` assumes the tracer always emits the background as the literal `var(--background)`; the emitter baked a concrete color for this one glyph, breaking the string-equality contract. `--background` isn't even defined in `app/globals.css`, so the two aren't interchangeable.
- **Impact**: When `EmotionGlyph` is mounted (finding 1's clear intent), `confused` renders an opaque `#1A040D` 1024×1024 box behind the sigil instead of a transparent field — a visibly broken emblem on any non-matching surface (cards, colored panels, blend contexts), unlike all seven siblings. Latent today only because the renderer is unmounted.
- **Fix sketch**: Make `strip` match the geometry regardless of fill, e.g. drop any path whose `d` matches `/^[Mm]0 0h1024v1024/` (the full-canvas rect signature) rather than gating on `fill`; or fix the emitter to always write `var(--background)`.

## 3. Self-drawing reveal renderer duplicated across the two glyph components
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `web/components/ui/EmotionGlyph.tsx:51` and `web/components/ui/GeneratedGlyph.tsx:39`
- **Scenario**: Both components map `glyph.paths` to `motion.path` with the same choreography — `initial={{opacity:0, scale:0.6}}`, `animate={{opacity:1, scale:1}}`, `transition={{duration:0.5, ease:[0.22,1,0.36,1]}}` — differing only in the delay source and transform-origin.
- **Root cause**: The staggered `{d,fill,delay}[]` reveal was copy-adapted into each component rather than extracted, so the two now silently diverge: `EmotionGlyph` normalizes `delay/maxDelay*SPREAD` with `transformBox:"fill-box"` + `transformOrigin:"center"`, while `GeneratedGlyph` uses raw `p.delay` with `transformOrigin:"512px 512px"`. That divergence is exactly what produced finding 4's timing bug.
- **Impact**: Two sources of truth for the same animation; base and custom glyphs already animate at different speeds/origins, and future tweaks must be applied twice or drift further.
- **Fix sketch**: Extract a shared `GlyphPaths` renderer (props: `paths`, `animate`, delay-mapping fn) used by both `EmotionGlyph` and `GeneratedGlyph`; pass the per-component origin/normalization as options so the choreography lives in one place.

## 4. `maxDelay` reduce seed of `1` defeats the SPREAD normalization
- **Severity**: low
- **Lens**: bug-hunter
- **Category**: logic-error
- **File**: `web/components/ui/EmotionGlyph.tsx:31`
- **Scenario**: `maxDelay = glyph.paths.reduce((m,p)=>Math.max(m,p.delay), 1) || 1`. Every real path delay across all glyphs is ≤ ~0.53, so the seed value `1` always wins → `maxDelay` is permanently `1`. The transition `delay: (p.delay/maxDelay)*SPREAD` (line 60) therefore reduces to `p.delay*0.5`, and never stretches the reveal to the intended `SPREAD` (0.5s); the last path lands at ~0.27s instead of 0.5s.
- **Root cause**: The reduce initial value should be `0` (letting the trailing `|| 1` act as the divide-by-zero guard for an all-zero-delay glyph). Seeding with `1` makes the normalization a no-op and the guard dead.
- **Impact**: Base-glyph reveals run ~2× faster than the documented `SPREAD` spec, and — combined with finding 3 — out of sync with custom sigils. Latent today (renderer unmounted).
- **Fix sketch**: Change the reduce seed to `0`: `paths.reduce((m,p)=>Math.max(m,p.delay), 0) || 1`.

## 5. Mid-file `import` in `emotions.ts`
- **Severity**: low
- **Lens**: code-refactor
- **Category**: structure
- **File**: `web/lib/emotions.ts:27`
- **Scenario**: `import { hueFor } from "./glyphs/generate";` sits at line 27, after the `EmotionMeta` type, the `EMOTIONS` array, and the `EMOTION_IDS` export.
- **Root cause**: The dependency on `generate.ts` was added later and dropped in place next to its first use rather than hoisted to the file's import block; ES hoisting makes it work but it reads as a hidden dependency and trips `import/first`.
- **Impact**: Minor readability/lint debt; the module's dependency on the glyph layer is easy to miss.
- **Fix sketch**: Move the `hueFor` import up to join the top-of-file imports.
