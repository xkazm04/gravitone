---
name: motionize
description: Upgrade a generic UI icon or loading/empty state into a traced, motion-animated SVG. Generates flat trace-friendly art (via /leonardo tools), validates with Qwen vision, vectorizes to a clean multi-path SVG, and emits a Motion (framer-motion) reveal component. For icon + loading-state visual upgrades — NOT raw image generation (use /leonardo for that).
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(node *), Bash(npx *), Bash(cd *)
argument-hint: <UI surface to upgrade, e.g. "teams empty state icon">
---

# Motionize — traced, animated SVG upgrades for icons & loading states

Turn a generic lucide icon + a basic fade into a **traced, self-drawing SVG** whose
every element is under your control (draw order, per-path timing, easing). This
skill is the *upgrade* layer; **`/leonardo` stays the pure image/illustration
generator**. Motionize consumes flat art and produces animated React components.

**The core idea:** neon/glow art traces badly (soft edges → speckle). Generate a
**flat** twin (solid fills, hard edges, no glow/gradients), trace *that*, then add
glow back as an SVG/CSS filter — that separation is what puts traces "under control".

**Read [`ART_STYLE.md`](./ART_STYLE.md) first** — the shared visual language (concept-
art / cinematic feel via a dark surface + tight neon accent set + emissive SVG-filter
glow) so every glyph is consistent. **Always produce a dark AND a light variant** —
we own the coloring, so no asset should be one bitmap stretched across themes
(recolor the same traced SVG per role, selected via `useIsDarkTheme()`; the tracer's
negative-space `var(--background)` flips with the theme for free).

## Pipeline (four steps)

### 0. One-time setup
Install the skill's self-contained deps (kept out of the app's package.json):
```bash
cd .claude/skills/motionize && npm install && cd -
```

### 1. Generate flat, trace-friendly art (via /leonardo tools)
Use the existing generators, but with a FLAT profile — no glow, no gradients:
```bash
export $(grep -E '^(OPENAI_API_KEY|LEONARDO_API_KEY|QWEN_API_KEY)=' .env | xargs)
# transparent bg is ideal for icons (gpt-image-2 supports it natively):
node .claude/skills/leonardo/tools/openai-image.mjs generate \
  --prompt "Flat vector icon of <SUBJECT>: solid fills, crisp hard edges, thick uniform outlines, no gradients, no glow, no shadow, limited palette (<=4 colors), centered" \
  --output .claude/skills/motionize/out/<name>-flat.png --size 1024x1024 --background transparent --quality high
# (or leonardo-gpt-image.mjs / leonardo-image.mjs when only a Leonardo key is present)
```

### 2. Validate with Qwen (free, Gemini-free)
```bash
node .claude/skills/motionize/tools/qwen-recognize.mjs \
  --input .claude/skills/motionize/out/<name>-flat.png \
  --prompt "Is this a FLAT icon (solid fills, hard edges, no gradients/glow)? How many distinct colors? Name the shapes. Reply JSON {flat:bool, colors:int, shapes:[...]}."
```
DashScope OpenAI-compatible endpoint, `qwen3.7-plus` + quota-fallbacks, `$QWEN_API_KEY`
(free 1M tokens / 90 days per model). If it isn't flat/clean, re-prompt step 1.

### 3. Trace → clean SVG (+ animatable data, one pass)
```bash
node .claude/skills/motionize/tools/trace.mjs \
  --input .claude/skills/motionize/out/<name>-flat.png \
  --output .claude/skills/motionize/out/<name>.svg \
  --mode spline --color-precision 4 --filter-speckle 6 \
  --emit src/features/<area>/<name>GlyphData.ts --name <NAME>_GLYPH   # folds in the data step
```
`@neplex/vectorizer` (VTracer) → one `<path>` per color region + SVGO cleanup.
`--emit`/`--name` bakes the paths into a `{ d, fill, delay }[]` TS module in the
same pass (radial `delay` = distance to centre, so a many-path trace becomes an
orchestrated center-out reveal; `--order angular` for a clockwise sweep). Handles
the trace gotchas (drops full-canvas bg, recolors large negative-space to
`var(--background)`, preserves paint order). Tune `--filter-speckle` (10–40) + lower
`--color-precision` (3–4) until the path count matches the *real* regions.
(`emit-glyph.mjs` is the same core as a standalone CLI.)

### 4. Motionize → React component
A tiny data-driven component maps the emitted array to **Motion (framer-motion)**:
- `NETWORK_GLYPH.map(p => <motion.path d={p.d} fill={p.fill} … delay={p.delay*SPREAD} />)`.
- **Opacity always, transform when allowed** — opacity cross-fade plays even under
  reduced motion (`useMotion().shouldAnimate` gates the scale/pop, NOT the fade), so
  the reveal is never a hard snap. Scale from each path's own centre with
  `style={{ transformOrigin: 'center', transformBox: 'fill-box' }}`.
- Add glow via an SVG `<filter>` (feGaussianBlur+feMerge) on accent paths for the
  cinematic emissive look; a faint `<radialGradient>` behind = "fog".
- For a frame-exact rendered asset, drive the same paths with Remotion `interpolate`.
- Ship a **dark + light** variant (recolor the array by role, pick via `useIsDarkTheme`).
  Self-contained component, SVG baked at authoring time (no runtime tracing).

## Gotchas (learned)

- **VTracer traces FILLED regions, and the background is one of them.** The white
  canvas becomes its own path, and interior negative space (holes, the gaps that
  make links read as *thin lines*) becomes separate white paths too. For a
  background-less icon: **drop the full-canvas bg path, but RECOLOR interior white
  paths to the surface colour** (`fill="var(--background)"`) — don't drop them, or
  connective lines/holes fill solid. Verify by rendering the composed SVG on the
  target surface (`sharp(Buffer.from(svg)).png()`) *before* wiring the component.
- **Filled paths don't "stroke-draw."** `pathLength` reveals a *stroke*; on a
  filled region it traces the boundary (messy). Reveal filled art with staggered
  opacity/scale/clip per element instead. Use `pathLength` only on genuinely
  line-based traces (`--mono` outlines).
- **Noise → path explosion.** Anti-aliased edges yield hundreds of micro-paths.
  Push `--filter-speckle` (10–40) and lower `--color-precision` (3–4) until the
  path count matches the number of *real* regions; sweep a couple values and check.
- **More content = more control.** A richer flat scene (a network, a small cast,
  accent nodes) traces into many addressable paths — group them by role and
  orchestrate the reveal (hub → links → figures → accents) for creative results.

## Conventions
- Scratch art + SVGs live in `.claude/skills/motionize/out/` (git-ignored working
  area). The FINAL committed artifact is the React component (inline SVG) in the
  feature, not the PNG.
- Respect the app's motion norms: honor `useMotion()`/reduced-motion; keep reveals
  short (< 1s) and non-blocking.
- Env: `QWEN_API_KEY` (recognition) + `OPENAI_API_KEY`/`LEONARDO_API_KEY`
  (generation). Load from `.env` before running.

## First POC
`src/features/teams/sub_teamWorkspace/TeamList.tsx` → `EmptyState`: a generic
`<Users>` icon + `animate-fade-slide-in`. Replace the icon with a traced,
self-drawing teams glyph as the reference implementation.
