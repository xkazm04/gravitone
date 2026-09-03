/*
 * The one piece of the illustration vocabulary that is pure geometry — no DOM,
 * no React, no colour. It lives beside illus.tsx rather than inside it because
 * it is the only part with its own test file (illus.test.ts), and because a
 * wave shape is arithmetic that several spotlights compute at module scope
 * before anything renders. `illus.tsx` re-exports it, so the vocabulary still
 * has one import site.
 */

/* ══════════════════════════════ waveform geometry ═════════════════════════ */

export type WaveOpts = {
  /** Box the wave is drawn into, in the parent SVG's user units. */
  w: number;
  h: number;
  /** Peak deflection as a fraction of h/2. Default 0.8. */
  amplitude?: number;
  /** Cycles across the full width. Default 3. */
  frequency?: number;
  /** Phase offset in radians. Default 0. */
  phase?: number;
  /** Sample count. TWO WAVES SHARING A `points` VALUE SHARE A COMMAND
   *  STRUCTURE, which is what makes them morphable — framer can tween `d`
   *  between them. Default 96. */
  points?: number;
  /** Envelope taper, 0 (rectangular) … 1 (pinched to the midline at both
   *  ends). Default 1 — an utterance starts and ends at silence. */
  damp?: number;
  /** Amount of a non-integer overtone mixed in, 0 … 1. A pure sine reads as
   *  "sine wave"; a little inharmonic content reads as "voice". Default 0.35. */
  harmonic?: number;
  /** Left edge, in user units. Default 0. */
  x?: number;
  /** Vertical centre. Default h / 2. */
  y?: number;
};

/**
 * A waveform as an SVG path — pure, deterministic, no DOM.
 *
 * Deterministic matters twice over: the server and the client must draw the
 * same wave (a random one hydrates as a mismatch), and a morph target must be
 * reproducible from props alone.
 */
export function wavePath(o: WaveOpts): string {
  const {
    w,
    h,
    amplitude = 0.8,
    frequency = 3,
    phase = 0,
    points = 96,
    damp = 1,
    harmonic = 0.35,
    x = 0,
    y = h / 2,
  } = o;
  const n = Math.max(2, Math.round(points));
  const peak = (h / 2) * amplitude;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // Envelope: 1 at the centre, (1 - damp) at both edges.
    const env = 1 - damp * (2 * t - 1) ** 2;
    const s =
      (Math.sin(2 * Math.PI * frequency * t + phase) +
        harmonic * Math.sin(2 * Math.PI * frequency * 2.7 * t + phase * 1.4)) /
      (1 + harmonic);
    const px = x + t * w;
    const py = y - peak * env * s;
    parts.push(`${i === 0 ? "M" : "L"}${round(px)} ${round(py)}`);
  }
  return parts.join(" ");
}

const round = (v: number) => Math.round(v * 100) / 100;
