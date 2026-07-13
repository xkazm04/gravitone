// Playground model. A take is spoken by ONE Character; metatags switch its
// emotion Voices mid-sentence, falling back to baseline where missing.

export type Segment = {
  text: string;
  requested: string;
  used: string;
  fallback: boolean;
  voice_id: string;
  seconds: number;
};

export type Take = {
  id: string;
  text: string;
  characterId: string;
  characterName: string;
  mode: "gravitone" | "browser";
  url?: string;
  peaks: number[];
  seconds: number;
  kb: number;
  rtf: number;
  // Honest timing (server-side synthesis time + queue wait, seconds) and any
  // accepted-but-inert voice settings the backend reported ignoring.
  synthSeconds: number;
  queueSeconds: number;
  ignoredSettings: string[];
  segments: Segment[];
  // The expression knobs this take was rendered with — together with text +
  // characterId this is the exact reproduction recipe for the code export.
  expr: Expression;
};

/** Expression controls. Pocket TTS has no emotion/speed parameter — these are
 *  the model's real sampling knobs (temp / noise_clamp / lsd_decode_steps). */
export type Expression = {
  temperature: number; // 0.5 consistent .. 1.0 expressive
  stability: number;   // 0 off .. 1 tight (noise_clamp)
  quality: number;     // 1 fast .. 5 best (costs realtime factor)
};

export const DEFAULT_EXPRESSION: Expression = { temperature: 0.7, stability: 0, quality: 1 };

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

/** Remove metatags — used for the browser-speech fallback and char counts. */
export function stripTags(text: string): string {
  return text.replace(/\[\/?[a-zA-Z_]*\]/g, "").replace(/\s+/g, " ").trim();
}

export const DEFAULT_TEXT =
  "Hello there. [excited]This part is amazing![/excited] And now, back to normal.";
