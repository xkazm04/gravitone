// The byte layer of a live conversation: Float32 mic samples in, base64 PCM16
// frames out; base64 PCM16 agent frames in, a playable WAV take out.
//
// Everything here is PURE and endian-EXPLICIT. Int16Array over a raw buffer
// would inherit the platform's byte order, and the wire (service/convai.py) is
// little-endian PCM16 always — on a big-endian host that difference is not a
// crash, it is a conversation that sounds like static. So every sample is read
// and written through a DataView with `littleEndian = true`, which is also what
// makes these functions testable without an AudioContext.
//
// This module deliberately does NOT live in web/lib: `lib/wavEncode.ts` is
// PUNCH-IN's file for the splice kernel (a different job — decode + crossfade +
// re-master on the shared AudioContext). If both survive review, the WAV header
// writer is the one thing worth merging.

/** 16 kHz is what the service's ears want (`convai_audio_rate`). */
export const DEFAULT_WIRE_RATE = 16_000;

/** Float32 (-1..1) → PCM16, clipped rather than wrapped.
 *  Wrapping a hot sample turns a loud syllable into a click. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const v = input[i];
    const clamped = v > 1 ? 1 : v < -1 ? -1 : v;
    out[i] = Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff));
  }
  return out;
}

/** PCM16 → Float32 (-1..1), for handing a decoded frame to Web Audio. */
export function pcm16ToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = pcm[i] / 0x8000;
  return out;
}

/** PCM16 → little-endian bytes. */
export function pcm16ToBytes(pcm: Int16Array): Uint8Array {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(i * 2, pcm[i], true);
  return bytes;
}

/** Little-endian bytes → PCM16. An odd trailing byte is dropped: half a sample
 *  is not a sample, and guessing its partner is how a decoder invents noise. */
export function bytesToPcm16(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.length / 2);
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i += 1) out[i] = view.getInt16(i * 2, true);
  return out;
}

// btoa over one huge string blows the argument stack; 8 KiB slices do not.
const B64_CHUNK = 0x2000;

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

/** One `user_audio_chunk` payload. */
export function pcm16ToBase64(pcm: Int16Array): string {
  return bytesToBase64(pcm16ToBytes(pcm));
}

/** One inbound `audio_event.audio_base_64` payload, or null when it is not
 *  decodable — a malformed frame drops the frame, never the call (the service
 *  drops OUR malformed frames the same way). */
export function base64ToPcm16(b64: string): Int16Array | null {
  try {
    return bytesToPcm16(base64ToBytes(b64));
  } catch {
    return null;
  }
}

export function concatPcm16(chunks: readonly Int16Array[]): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Mono PCM16 → a 44-byte-header RIFF WAV blob.
 *
 * This is what makes a spoken turn a real `Take`: the console's whole shipped
 * pipeline (computePeaks, the player, /api/takes publishing, the review link,
 * the download) consumes a wav blob, so encoding one here buys every one of
 * those unchanged instead of teaching them about a new audio shape.
 */
export function encodeWav(pcm: Int16Array, sampleRate: number): Blob {
  const data = pcm16ToBytes(pcm);
  const buffer = new ArrayBuffer(44 + data.length);
  const view = new DataView(buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + data.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);        // PCM fmt chunk size
  view.setUint16(20, 1, true);         // format 1 = PCM
  view.setUint16(22, 1, true);         // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
  view.setUint16(32, 2, true);         // block align
  view.setUint16(34, 16, true);        // bits per sample
  ascii(36, "data");
  view.setUint32(40, data.length, true);
  new Uint8Array(buffer).set(data, 44);
  return new Blob([buffer], { type: "audio/wav" });
}

/** Seconds of audio in a PCM16 frame at `rate`, rounded like a take's seconds. */
export function pcmSeconds(pcm: Int16Array, rate: number): number {
  if (!rate) return 0;
  return Math.round((pcm.length / rate) * 10) / 10;
}

/** `pcm_16000` → 16000. Anything unparseable falls back to the wire default
 *  rather than to 0, which would make every duration NaN. */
export function parseAudioFormat(format: string | undefined | null): number {
  const n = Number(String(format ?? "").replace(/^pcm_?/i, ""));
  return Number.isFinite(n) && n >= 8000 ? n : DEFAULT_WIRE_RATE;
}
