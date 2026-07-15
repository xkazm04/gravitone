// The glyph shape: the {viewBox, paths[]} contract a renderer animates as a
// staggered, center-out self-drawing reveal.
//
// This module also held GLYPHS — eight hand-traced emotion glyphs baked from
// /motionize and rendered by an <EmotionGlyph> component. That variant lost and
// was never mounted: EmotionArt renders the baked PNGs (public/emotions/*.png)
// for the base emotions and falls back to a procedural sigil (./generate) for
// custom ones. Per this repo's prototype convention — when a winner is chosen,
// delete the losing variant — the traced data and its renderer are gone. Only
// the shared shape remains, which ./generate builds against.

export type GlyphPath = { d: string; fill: string; delay: number };
export type Glyph = { viewBox: string; paths: GlyphPath[] };
