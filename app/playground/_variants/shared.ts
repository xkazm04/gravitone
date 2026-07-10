// Shared model + mock generation for the Playground prototype variants.
// (UI prototype — generation is simulated; wire to POST /v1/text-to-speech later.)

export type Voice = {
  id: string;
  name: string;
  lang: string;
  source: "built-in" | "cloned";
  sample?: string; // clone sample length, e.g. "16s"
  rtf: number; // realtime factor on the reference box
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
  seconds: number;
  rtf: number;
  kb: number;
  seed: number;
};

let takeSeq = 0;

/** Simulate synthesis: latency ∝ audio length ÷ rtf. Resolves to a Take. */
export function fakeGenerate(text: string, voice: Voice): Promise<Take> {
  const seconds = Math.max(1.5, Math.round(text.trim().length * 0.055 * 10) / 10);
  const kb = Math.round(seconds * 24000 * 2 / 1024);
  const synthMs = Math.min(2600, (seconds / voice.rtf) * 1000);
  takeSeq += 1;
  const id = `take-${takeSeq}`;
  const seed = (text.length * 31 + takeSeq * 7) % 997;
  return new Promise((resolve) =>
    setTimeout(
      () => resolve({ id, text: text.trim(), voiceId: voice.id, voiceName: voice.name, seconds, rtf: voice.rtf, kb, seed }),
      synthMs
    )
  );
}

/** Deterministic pseudo-waveform heights from a seed (static — no infinite motion). */
export function waveHeights(seed: number, n = 48): number[] {
  const out: number[] = [];
  let s = seed || 1;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const env = Math.sin((i / n) * Math.PI); // fade in/out envelope
    out.push(0.18 + ((s % 100) / 100) * 0.82 * (0.5 + env * 0.5));
  }
  return out;
}

export const DEFAULT_TEXT =
  "Hi — this is my cloned voice, generated locally on an Arm CPU. If this sounds like me, the studio works.";
