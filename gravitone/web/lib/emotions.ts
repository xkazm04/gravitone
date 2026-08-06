// The emotion scale — must stay in step with service/emotions.py::EMOTION_SCALE.
//
// Vocabulary:
//   Voice     = one speaker in ONE emotion (one embedding).
//   Character = a group of Voices across the scale. `baseline` is mandatory.
// Requests for an emotion a Character lacks fall back to its baseline Voice.

export type EmotionMeta = { id: string; label: string; hue: number; art: string };

// art = glowing line-art emblem on pure black (generated via /leonardo → Gemini
// image). Render it with mix-blend-mode:screen so the black drops out on the
// dark UI. Trace-friendly for a future /motionize pass.
export const EMOTIONS: EmotionMeta[] = [
  { id: "baseline", label: "Baseline", hue: 200, art: "/emotions/baseline.png" },
  { id: "calm", label: "Calm", hue: 170, art: "/emotions/calm.png" },
  { id: "happy", label: "Happy", hue: 48, art: "/emotions/happy.png" },
  { id: "excited", label: "Excited", hue: 20, art: "/emotions/excited.png" },
  { id: "sad", label: "Sad", hue: 225, art: "/emotions/sad.png" },
  { id: "angry", label: "Angry", hue: 355, art: "/emotions/angry.png" },
  { id: "whisper", label: "Whisper", hue: 275, art: "/emotions/whisper.png" },
  { id: "confused", label: "Confused", hue: 305, art: "/emotions/confused.png" },
];

export const BASELINE = "baseline";
export const EMOTION_IDS = EMOTIONS.map((e) => e.id);

import { hueFor } from "./glyphs/generate";

/** True for the eight emotions that ship hand-traced art. */
export function isBaseEmotion(id: string): boolean {
  return EMOTION_IDS.includes(id);
}

/**
 * Metadata for any emotion — including a Character's CUSTOM slots, which have
 * no baked art. Custom emotions get a deterministic hue and an empty `art`
 * path; EmotionArt renders their procedural sigil instead of an image.
 */
export function emotionMeta(id: string): EmotionMeta {
  const known = EMOTIONS.find((e) => e.id === id);
  if (known) return known;
  return {
    id,
    label: id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    hue: hueFor(id),
    art: "", // no baked image — generated glyph
  };
}

// `wrapWithTag` used to live here and spliced `[x]…[/x]` literals straight into
// the composer's string, parking the caret INSIDE an empty pair — one backspace
// left `[x[/x]`, which the engine's tag regex does not match and therefore
// speaks out loud. Emotions are now applied as REGIONS over plain text
// (app/playground/_variants/shared.ts::applyEmotion), and the tagged string is
// derived on the way out. Do not reintroduce a literal-splicing helper.
