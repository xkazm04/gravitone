// Auto-generated glyphs for CUSTOM emotions.
//
// The eight base emotions ship hand-traced art (leonardo → motionize, baked
// into lib/glyphs/*.ts). A user-invented emotion ("sarcastic", "battle_cry")
// has none — and generating art needs an offline API pass. So custom emotions
// get a *procedural sigil*: deterministic geometry seeded from the emotion
// name, in the same {viewBox, paths[]} shape as the traced glyphs, so it
// animates through the identical self-drawing reveal and hue system.
//
// Same name → same sigil, forever, on every machine. No network, no keys.

import type { Glyph, GlyphPath } from "./index";

/** FNV-1a — small, stable, no deps. The whole visual identity hangs off it. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic 0..1 stream from a seed. */
function rng(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function hueFor(emotion: string): number {
  return hash(emotion) % 360;
}

const C = 512; // canvas centre (viewBox is 1024, matching the traced glyphs)

/** A closed petal/blade from the centre, rotated to `angle`. */
function petal(angle: number, len: number, width: number, curve: number): string {
  const rad = (angle * Math.PI) / 180;
  const tx = C + Math.cos(rad) * len;
  const ty = C + Math.sin(rad) * len;
  const perp = rad + Math.PI / 2;
  const wx = Math.cos(perp) * width;
  const wy = Math.sin(perp) * width;
  const c1x = C + Math.cos(rad) * len * curve + wx;
  const c1y = C + Math.sin(rad) * len * curve + wy;
  const c2x = C + Math.cos(rad) * len * curve - wx;
  const c2y = C + Math.sin(rad) * len * curve - wy;
  return `M${C} ${C} Q${c1x.toFixed(1)} ${c1y.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)} Q${c2x.toFixed(1)} ${c2y.toFixed(1)} ${C} ${C}Z`;
}

function ring(r: number): string {
  return `M${C - r} ${C}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0Z`;
}

/**
 * Build a sigil for one emotion name. Rendered with `currentColor` so the
 * caller tints it with the emotion hue, exactly like the traced glyphs.
 */
export function generateGlyph(emotion: string): Glyph {
  const seed = hash(emotion);
  const rand = rng(seed);

  const blades = 5 + (seed % 7);          // 5..11 rays
  const len = 300 + rand() * 130;         // reach
  const width = 30 + rand() * 70;         // fatness
  const curve = 0.45 + rand() * 0.35;     // straight blade ↔ round petal
  const twist = rand() * 40 - 20;         // asymmetry
  const innerRing = 55 + rand() * 60;

  const paths: GlyphPath[] = [];
  for (let i = 0; i < blades; i++) {
    const angle = (i / blades) * 360 + twist * (i % 2 ? 1 : -1);
    const scale = 0.72 + rand() * 0.28;   // uneven rays read as organic
    paths.push({
      d: petal(angle - 90, len * scale, width * scale, curve),
      fill: "currentColor",
      // center-out stagger, same choreography as the traced reveals
      delay: Number((0.05 + (i / blades) * 0.5).toFixed(3)),
    });
  }
  paths.push({ d: ring(innerRing), fill: "currentColor", delay: 0 });

  return { viewBox: "0 0 1024 1024", paths };
}
