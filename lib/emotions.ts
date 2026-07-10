// The emotion scale — must stay in step with service/emotions.py::EMOTION_SCALE.
//
// Vocabulary:
//   Voice     = one speaker in ONE emotion (one embedding).
//   Character = a group of Voices across the scale. `baseline` is mandatory.
// Requests for an emotion a Character lacks fall back to its baseline Voice.

export type EmotionMeta = { id: string; label: string; hue: number };

export const EMOTIONS: EmotionMeta[] = [
  { id: "baseline", label: "Baseline", hue: 200 },
  { id: "calm", label: "Calm", hue: 170 },
  { id: "happy", label: "Happy", hue: 48 },
  { id: "excited", label: "Excited", hue: 20 },
  { id: "sad", label: "Sad", hue: 225 },
  { id: "angry", label: "Angry", hue: 355 },
  { id: "whisper", label: "Whisper", hue: 275 },
  { id: "confused", label: "Confused", hue: 305 },
];

export const BASELINE = "baseline";
export const EMOTION_IDS = EMOTIONS.map((e) => e.id);

export function emotionMeta(id: string): EmotionMeta {
  return EMOTIONS.find((e) => e.id === id) ?? EMOTIONS[0];
}

/** Wrap a selection (or insert an empty pair) with an emotion metatag. */
export function wrapWithTag(text: string, start: number, end: number, emotion: string) {
  const sel = text.slice(start, end);
  const open = `[${emotion}]`;
  const close = `[/${emotion}]`;
  const next = text.slice(0, start) + open + sel + close + text.slice(end);
  const caret = sel ? start + open.length + sel.length + close.length : start + open.length;
  return { next, caret };
}
