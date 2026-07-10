# Motionize — Art-Style Philosophy

The shared visual language for motionized icons, empty states, and loading
surfaces. Read this before generating so every traced glyph feels like it belongs
to the same world. This is **inspiration + memory**, not a rigid spec.

## The aspiration (master descriptor)

> **Concept art / digital painting, high detail, cinematic.** A rendered-but-
> artistic look with depth and polish — not a photograph, not a flat clip-art
> illustration. Moody, atmospheric, sophisticated, slightly cold. Quiet, not
> chaotic.

We can't *trace* a painterly render (glow + fog + gradients trace into noise), so
we **reproduce the FEEL through the pipeline**, not the pixels:

| Cinematic cue | How we get it under trace-control |
|---|---|
| **Dark, low-key base** (deep navy / black) | The *surface* is dark — the app theme, not the illustration. We trace flat shapes on white, then render on the dark surface. |
| **Tight neon accent set** — electric **violet**, **teal**, **amber** | The single most transferable element. Flat-fill the traced shapes in these hues + dark-navy outlines. Keep the palette *tight* (≤4 accents). |
| **Emissive lighting / glow** (light comes from objects) | Added AFTER tracing as an **SVG filter** (`feGaussianBlur` + `feMerge`) or a soft `drop-shadow` on accent strokes — because we own the SVG. Never bake glow into the raster (untraceable). |
| **Volumetric fog / particles** | Faint animated accent dots + a low-opacity radial gradient *behind* the glyph (a `<radialGradient>` we add), not in the trace. |
| **Cinematic radial composition** | Generate a single hero anchored in negative space, radial/semicircular framing. Compose for 1:1 or 16:9 hero, not a busy scene. |

## Palette tokens

- **Base / surface:** `var(--background)` (dark) — the illustration never carries its own bg.
- **Accents (tight set):** electric violet `#8B5CF6`–`#7C3AED`, teal/cyan `#2DD4BF`–`#06B6D4`, amber `#F59E0B`. Blue/indigo `#6366F1` as a cool neutral.
- **Line-work:** deep navy `#0D1F51`–`#132053` (dark theme) — reads as premium ink.
- Keep saturated accents *sparse* — glow earns its place against darkness.

## Light / dark — ALWAYS both

Because we own the coloring, **every asset ships a dark and a light variant** — never
one bitmap stretched across themes. Two ways, cheapest first:

1. **Recolor the same traced SVG** (preferred): the geometry is identical; only fills
   change. Map dark→light per-role (outline navy→slate, negative-space
   `var(--background)` follows the theme automatically, accents slightly deepened for
   contrast on light). One SVG, two palettes, selected via `useIsDarkTheme()`.
2. **Regenerate a light-optimised source** only when the composition itself must
   change (rare for glyphs).

The tracer's interior "negative space" is already `var(--background)`, so it flips
with the theme for free. Accents on a light base should **deepen ~10–15%** (neon on
white can vibrate); glow filters should **soften** (light surfaces don't emit).

## Motion (how it reveals)

- **Radiate, don't snap.** Reveal from the hero outward (center-out radial delay),
  or a slow clockwise sweep. Quiet and deliberate — matches the "moody, not chaotic"
  mood. ~0.8–1.2s total.
- **Opacity always; transform when allowed.** Opacity cross-fade plays even under
  reduced motion; scale/pop only in full motion.
- **Emissive accents can breathe.** After the reveal, accent dots / orbit arcs may
  pulse or drift *slowly* (loading states), never busily.

## Signature system — the Persona Head glyph

The canonical way to *depict a persona/archetype* is an **abstract AI persona
head-and-face glyph** in glowing hairline linework — one symbol per archetype,
same construction, so a persona reads instantly and its variations feel like one
family. This is the signature "what a Persona visually IS" tool; reuse it wherever
an archetype/persona needs a face (mentality cards, persona headers, pickers).

**Prompt template** (keep it verbatim except the bracketed bits):
> A single abstract AI persona head-and-face glyph, centered, on a flat solid
> **black** background. The head is a **[SILHOUETTE]** rendered in minimal glowing
> linework — **[2–3 distinctive features]**. **[3 personality adjectives]**. Uniform
> **[teal|violet|amber]** linework, evenly lit, no gradient falloff, no card, no
> frame, no UI, no fog, no particles. Sharp crisp edges, high contrast, uniform
> stroke weight, hairline outline only. Flat vector-illustration style, symmetrical,
> 1:1 aspect ratio.

- **Black background** (not white) — the tracer drops the full-canvas black and
  `emit-glyph`'s `nearBlack` (strict `max<26`, so navy line-work survives) sends
  interior black to `var(--background)`, leaving neon lines on the dark surface.
- **Tight 3-colour rotation** — teal / violet / amber cycled across the set, NOT
  each archetype's semantic colour. Uniformity is what makes them a family; the
  card frame can still carry the semantic colour.
- **Hairline, uniform stroke, no glow in the raster** — glow is the SVG filter
  later. "Head silhouette + a few confident feature lines," symmetrical, 1:1.
- Distinguish archetypes by **silhouette + feature motif**, not colour: guardian
  helmet/brow/shield-jaw, analyst scanning-lens + grid facets, operator hub-node +
  headset arc, craftsman faceted low-poly seams, scout swept crest + directional
  slashes, sentinel steady sensor eye + scan line, curator archive bands + keystone,
  shipper upward chevrons + decisive jaw, chief-of-staff crown arc + guarded eye.

## Consistency checklist

- Dark surface, tight neon accent set, navy line-work. ✔
- Single hero in negative space; radial framing. ✔
- Glow/fog are SVG filters + faint particles, not baked. ✔
- Dark + light variant both exist. ✔
- Reveal radiates and is quiet. ✔

## Provenance

Sources of the master descriptor: the app's larger-illustration art direction
(concept-art / cinematic / neon-on-dark). Extend this doc as the style evolves —
it is the durable memory that keeps traced glyphs coherent with the rendered art.
