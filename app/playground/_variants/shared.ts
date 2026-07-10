// Model + waveform helpers for the Playground.

export type Voice = {
  id: string;
  name: string;
  lang: string;
  source: "built-in" | "cloned";
  sample?: string;
  rtf: number;
  hue: number;
};

export const VOICES: Voice[] = [
  { id: "alba", name: "Alba", lang: "EN", source: "built-in", rtf: 1.9, hue: 190 },
  { id: "marius", name: "Marius", lang: "EN", source: "built-in", rtf: 1.7, hue: 265 },
  { id: "estelle", name: "Estelle", lang: "FR", source: "built-in", rtf: 1.8, hue: 150 },
  { id: "giovanni", name: "Giovanni", lang: "IT", source: "built-in", rtf: 1.6, hue: 32 },
  { id: "mine", name: "Your voice", lang: "EN", source: "cloned", sample: "16s", rtf: 1.9, hue: 340 },
];

export type Take = {
  id: string;
  text: string;
  voiceId: string;
  voiceName: string;
  hue: number;
  mode: "gravitone" | "browser";
  url?: string; // object URL for the WAV (gravitone mode)
  peaks: number[]; // 0..1 bar heights (real for gravitone, synthetic for browser)
  seconds: number;
  kb: number;
  rtf: number;
};

/** Deterministic pseudo-waveform for browser-fallback takes. */
export function waveHeights(seed: number, n = 48): number[] {
  const out: number[] = [];
  let s = seed || 1;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const env = Math.sin((i / n) * Math.PI);
    out.push(0.18 + ((s % 100) / 100) * 0.82 * (0.5 + env * 0.5));
  }
  return out;
}

export const DEFAULT_TEXT =
  "Hi — this is my cloned voice, generated locally on an Arm CPU. If this sounds like me, the studio works.";
