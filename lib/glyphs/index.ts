// Traced emotion glyphs (via /motionize). Each is a {d, fill, delay}[] baked
// from the generated art — animatable as a center-out self-drawing reveal.
import { BASELINE_GLYPH, BASELINE_GLYPH_VIEWBOX } from "./baseline";
import { CALM_GLYPH, CALM_GLYPH_VIEWBOX } from "./calm";
import { HAPPY_GLYPH, HAPPY_GLYPH_VIEWBOX } from "./happy";
import { EXCITED_GLYPH, EXCITED_GLYPH_VIEWBOX } from "./excited";
import { SAD_GLYPH, SAD_GLYPH_VIEWBOX } from "./sad";
import { ANGRY_GLYPH, ANGRY_GLYPH_VIEWBOX } from "./angry";
import { WHISPER_GLYPH, WHISPER_GLYPH_VIEWBOX } from "./whisper";
import { CONFUSED_GLYPH, CONFUSED_GLYPH_VIEWBOX } from "./confused";

export type GlyphPath = { d: string; fill: string; delay: number };
export type Glyph = { viewBox: string; paths: GlyphPath[] };

// Drop the full-canvas background rect the tracer emits (fill var(--background)).
const strip = (paths: GlyphPath[]): GlyphPath[] =>
  paths.filter((p) => !(p.fill === "var(--background)" && /^[Mm]0 0h1024v1024/.test(p.d)));

export const GLYPHS: Record<string, Glyph> = {
  baseline: { viewBox: BASELINE_GLYPH_VIEWBOX, paths: strip(BASELINE_GLYPH) },
  calm: { viewBox: CALM_GLYPH_VIEWBOX, paths: strip(CALM_GLYPH) },
  happy: { viewBox: HAPPY_GLYPH_VIEWBOX, paths: strip(HAPPY_GLYPH) },
  excited: { viewBox: EXCITED_GLYPH_VIEWBOX, paths: strip(EXCITED_GLYPH) },
  sad: { viewBox: SAD_GLYPH_VIEWBOX, paths: strip(SAD_GLYPH) },
  angry: { viewBox: ANGRY_GLYPH_VIEWBOX, paths: strip(ANGRY_GLYPH) },
  whisper: { viewBox: WHISPER_GLYPH_VIEWBOX, paths: strip(WHISPER_GLYPH) },
  confused: { viewBox: CONFUSED_GLYPH_VIEWBOX, paths: strip(CONFUSED_GLYPH) },
};
