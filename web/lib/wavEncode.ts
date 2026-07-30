// The splice kernel's arithmetic: decoded audio in, a WAV master out.
//
// The punch-in editor has to cut a take apart and put it back together with a
// re-rendered fragment in the middle. Everything that touches a browser API
// (decodeAudioData, the shared AudioContext) stays in the playground's engine;
// everything that is arithmetic lives HERE, on plain Float32Arrays, so the two
// things that can silently ruin a take — a boundary computed wrong and a WAV
// header that lies about its own payload — are testable without a browser.
//
// Conventions:
//   * DECODED length is the only duration truth. A take's header seconds and
//     the sum of its segment seconds are both reports; the samples are the
//     audio. Every function here measures the array it was handed.
//   * A splice never resamples. Everything is decoded on ONE AudioContext, so
//     every part arrives at that context's rate; a mismatch is a bug, not
//     something to paper over with a guess, so it throws.

/** Decoded audio: one Float32Array per channel, all the same length. */
export type Pcm = { channels: Float32Array[]; sampleRate: number };

/** The part of AudioBuffer this module reads (so tests need no browser). */
export type DecodedAudio = {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
};

/** Crossfade length at a splice boundary. Long enough to kill the click of a
 *  discontinuity, short enough that no syllable is smeared into its neighbour —
 *  boundaries land on segment edges, where the engine already cut. */
export const SPLICE_FADE_SECONDS = 0.012;

export function fromDecodedAudio(buf: DecodedAudio): Pcm {
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.max(1, buf.numberOfChannels); c++) {
    // Copy: decodeAudioData's arrays belong to the AudioBuffer, and a splice
    // writes into its own memory.
    channels.push(Float32Array.from(buf.getChannelData(c)));
  }
  return { channels, sampleRate: buf.sampleRate };
}

/** Samples per channel. */
export function pcmLength(p: Pcm): number {
  return p.channels[0]?.length ?? 0;
}

/** Duration of the SAMPLES, which is the duration of the audio. */
export function pcmDuration(p: Pcm): number {
  return p.sampleRate > 0 ? pcmLength(p) / p.sampleRate : 0;
}

/** Channel `i`, or the last one there is — a mono fragment spliced into a
 *  stereo take must not silence a channel. */
function channelAt(p: Pcm, i: number): Float32Array {
  return p.channels[Math.min(i, p.channels.length - 1)] ?? new Float32Array(0);
}

/**
 * The samples between two times, clamped to what exists.
 *
 * Times come from segment arithmetic, so they can land outside the buffer (a
 * report that over-counts) — an out-of-range slice returns an empty Pcm rather
 * than a negative length.
 */
export function slicePcm(p: Pcm, startSec: number, endSec: number): Pcm {
  const n = pcmLength(p);
  const a = Math.max(0, Math.min(n, Math.round(startSec * p.sampleRate)));
  const b = Math.max(a, Math.min(n, Math.round(endSec * p.sampleRate)));
  return {
    sampleRate: p.sampleRate,
    channels: p.channels.map((ch) => ch.slice(a, b)),
  };
}

/** Join two Pcms with an equal-length linear crossfade over the seam. */
function join(a: Pcm, b: Pcm, fadeSamples: number): Pcm {
  const aLen = pcmLength(a);
  const bLen = pcmLength(b);
  if (aLen === 0) return b;
  if (bLen === 0) return a;
  // The fade can never eat more than either side, or the seam would consume a
  // whole (short) fragment.
  const f = Math.max(0, Math.min(fadeSamples, aLen, bLen));
  const len = aLen + bLen - f;
  const nch = Math.max(a.channels.length, b.channels.length);
  const channels: Float32Array[] = [];
  for (let c = 0; c < nch; c++) {
    const src = channelAt(a, c);
    const dst = channelAt(b, c);
    const out = new Float32Array(len);
    out.set(src.subarray(0, aLen - f), 0);
    for (let i = 0; i < f; i++) {
      const w = (i + 1) / (f + 1);
      out[aLen - f + i] = src[aLen - f + i] * (1 - w) + dst[i] * w;
    }
    out.set(dst.subarray(f), aLen);
    channels.push(out);
  }
  return { channels, sampleRate: a.sampleRate };
}

/**
 * Concatenate parts with a short crossfade at every seam.
 *
 * Empty parts are dropped (a punch-in at the very start of a take has no head,
 * one at the end has no tail), so the caller can hand over head/fragment/tail
 * without special-casing the edges.
 */
export function crossfadeConcat(parts: Pcm[], fadeSeconds = SPLICE_FADE_SECONDS): Pcm {
  const real = parts.filter((p) => pcmLength(p) > 0);
  if (real.length === 0) throw new Error("nothing to splice");
  const rate = real[0].sampleRate;
  if (real.some((p) => p.sampleRate !== rate)) {
    // Every part is decoded on the same AudioContext, so this cannot happen
    // without a bug — and silently concatenating mismatched rates would change
    // the pitch of half the take.
    throw new Error("sample-rate mismatch between spliced parts");
  }
  const fadeSamples = Math.max(0, Math.round(fadeSeconds * rate));
  return real.reduce((acc, p) => join(acc, p, fadeSamples));
}

/** Reduce samples to N normalised peak bars — the ribbon's arithmetic, shared
 *  with engine.computePeaks so a spliced take's bars are computed exactly like
 *  a rendered one's. */
export function peaksFromSamples(data: Float32Array, n = 56): number[] {
  const chunk = Math.max(1, Math.floor(data.length / n));
  const peaks: number[] = [];
  for (let i = 0; i < n; i++) {
    let peak = 0;
    const start = i * chunk;
    for (let j = start; j < start + chunk && j < data.length; j++) {
      const v = Math.abs(data[j]);
      if (v > peak) peak = v;
    }
    peaks.push(peak);
  }
  const max = Math.max(...peaks, 0.001);
  return peaks.map((p) => Math.max(0.06, p / max));
}

export function peaksFromPcm(p: Pcm, n = 56): number[] {
  return peaksFromSamples(channelAt(p, 0), n);
}

const BYTES_PER_SAMPLE = 2; // PCM16 — the format the service itself masters in

/**
 * Encode PCM as a 16-bit little-endian RIFF/WAVE blob.
 *
 * The header is written from the ACTUAL array lengths, never from a caller's
 * idea of the duration: a WAV whose data chunk disagrees with its payload is
 * the class of bug that makes a take unplayable in one player and truncated in
 * another.
 */
export function encodeWav(p: Pcm): Blob {
  const nch = Math.max(1, p.channels.length);
  const frames = pcmLength(p);
  const rate = p.sampleRate;
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("invalid sample rate");
  const dataBytes = frames * nch * BYTES_PER_SAMPLE;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);          // PCM fmt chunk size
  view.setUint16(20, 1, true);           // format = PCM
  view.setUint16(22, nch, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * nch * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, nch * BYTES_PER_SAMPLE, true);        // block align
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true);          // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      // Clamp before scaling: a summed crossfade can exceed unity, and letting
      // it wrap would put a click exactly where the fade exists to remove one.
      const s = Math.max(-1, Math.min(1, channelAt(p, c)[i] ?? 0));
      view.setInt16(o, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
      o += BYTES_PER_SAMPLE;
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}
