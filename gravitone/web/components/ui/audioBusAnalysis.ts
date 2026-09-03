// The bus's arithmetic and its environment probes. Pure: no React, no refs, no
// side effects beyond reading the analyser the caller hands in.

type Ctor = new () => AudioContext;
export function audioContextCtor(): Ctor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
/** Quantise before writing: a var write is a style invalidation, and nobody can
 *  see the 4th decimal of a glow. */
export const q = (n: number) => Math.round(clamp01(n) * 1000) / 1000;

/** RMS is small for speech (~0.05–0.2); lift it into a usable 0..1 display
 *  range rather than shipping a bus that looks broken on real voices. */
export const LEVEL_GAIN = 3.2;
export const PEAK_GAIN = 1.15;
/** Reduced motion: resample this slowly, so the value reads as static. */
export const STATIC_SAMPLE_MS = 500;

export function sample(analyser: AnalyserNode, time: Uint8Array) {
  // `as never`: lib.dom types getByteTimeDomainData as Uint8Array<ArrayBuffer>
  // in TS 5.7+, which our plain Uint8Array does not structurally satisfy.
  analyser.getByteTimeDomainData(time as never);
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < time.length; i += 1) {
    const v = (time[i] - 128) / 128;
    sum += v * v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / time.length);
  return { rms: clamp01(rms * LEVEL_GAIN), peak: clamp01(peak * PEAK_GAIN) };
}

export function centroid(analyser: AnalyserNode, freq: Uint8Array) {
  analyser.getByteFrequencyData(freq as never);
  let mag = 0;
  let weighted = 0;
  for (let i = 0; i < freq.length; i += 1) {
    mag += freq[i];
    weighted += freq[i] * i;
  }
  if (mag <= 0) return null;
  return clamp01(weighted / mag / freq.length);
}
