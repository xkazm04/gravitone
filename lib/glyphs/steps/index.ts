// Traced pipeline-step glyphs (via /motionize) for the ingestion progress.
import { STEP_TRANSCRIBE, STEP_TRANSCRIBE_VIEWBOX } from "./transcribe";
import { STEP_ISOLATE, STEP_ISOLATE_VIEWBOX } from "./isolate";
import { STEP_LABEL, STEP_LABEL_VIEWBOX } from "./label";
import { STEP_STEM, STEP_STEM_VIEWBOX } from "./stem";
import type { Glyph, GlyphPath } from "@/lib/glyphs";

const strip = (paths: GlyphPath[]): GlyphPath[] =>
  paths.filter((p) => !(p.fill === "var(--background)" && /^[Mm]0 0h1024v1024/.test(p.d)));

export const STEP_GLYPHS: Record<string, Glyph> = {
  transcribe: { viewBox: STEP_TRANSCRIBE_VIEWBOX, paths: strip(STEP_TRANSCRIBE) },
  isolate: { viewBox: STEP_ISOLATE_VIEWBOX, paths: strip(STEP_ISOLATE) },
  label: { viewBox: STEP_LABEL_VIEWBOX, paths: strip(STEP_LABEL) },
  stem: { viewBox: STEP_STEM_VIEWBOX, paths: strip(STEP_STEM) },
};
