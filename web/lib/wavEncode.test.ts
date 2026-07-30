// The splice kernel's arithmetic, tested on synthesized buffers.
//
// Two failures here are silent and expensive: a boundary computed wrong (the
// user hears a word twice, or loses one) and a WAV header that disagrees with
// its own payload (a take that plays in one program and is truncated in
// another). Both are pure arithmetic, so both are pinned without a browser.

import { describe, expect, it } from "vitest";
import {
  crossfadeConcat, encodeWav, fromDecodedAudio, pcmDuration, pcmLength, peaksFromSamples,
  peaksFromPcm, slicePcm, SPLICE_FADE_SECONDS, type DecodedAudio, type Pcm,
} from "./wavEncode";

const RATE = 8000;

/** A constant-valued mono Pcm — easy to see which part of a splice you are in. */
function tone(seconds: number, value: number, rate = RATE): Pcm {
  const n = Math.round(seconds * rate);
  return { channels: [new Float32Array(n).fill(value)], sampleRate: rate };
}

/** The part of AudioBuffer the kernel reads, which is all decodeAudioData is to
 *  this module. */
function decoded(channels: Float32Array[], rate = RATE): DecodedAudio {
  return {
    numberOfChannels: channels.length,
    sampleRate: rate,
    length: channels[0].length,
    getChannelData: (i) => channels[i],
  };
}

function readWav(blob: ArrayBuffer) {
  const v = new DataView(blob);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  return {
    riff: tag(0), wave: tag(8), fmt: tag(12), data: tag(36),
    riffSize: v.getUint32(4, true),
    format: v.getUint16(20, true),
    channels: v.getUint16(22, true),
    sampleRate: v.getUint32(24, true),
    byteRate: v.getUint32(28, true),
    blockAlign: v.getUint16(32, true),
    bits: v.getUint16(34, true),
    dataSize: v.getUint32(40, true),
    sampleAt: (i: number) => v.getInt16(44 + i * 2, true),
  };
}

describe("fromDecodedAudio", () => {
  it("copies the channels — a splice writes into its own memory", () => {
    const src = new Float32Array([0.5, 0.25]);
    const p = fromDecodedAudio(decoded([src]));
    p.channels[0][0] = -1;
    expect(src[0]).toBe(0.5);
  });

  it("keeps every channel and the rate", () => {
    const p = fromDecodedAudio(decoded([new Float32Array(4), new Float32Array(4)], 24000));
    expect(p.channels).toHaveLength(2);
    expect(p.sampleRate).toBe(24000);
    expect(pcmDuration(p)).toBeCloseTo(4 / 24000, 6);
  });
});

describe("slicePcm — the boundary arithmetic", () => {
  it("cuts exactly the requested span", () => {
    const p = tone(1, 0.5);
    expect(pcmLength(slicePcm(p, 0.25, 0.75))).toBe(RATE / 2);
  });

  it("clamps a span the report over-counted instead of going negative", () => {
    // Segment seconds are a REPORT: their sum can exceed the decoded audio, and
    // a negative length would be a crash instead of a clamp.
    const p = tone(1, 0.5);
    expect(pcmLength(slicePcm(p, 2, 3))).toBe(0);
    expect(pcmLength(slicePcm(p, 0.9, 5))).toBe(Math.round(0.1 * RATE));
    expect(pcmLength(slicePcm(p, 0.8, 0.2))).toBe(0);
  });

  it("returns an empty head for a punch at the very start", () => {
    expect(pcmLength(slicePcm(tone(1, 1), 0, 0))).toBe(0);
  });
});

describe("crossfadeConcat", () => {
  const fadeSamples = Math.round(SPLICE_FADE_SECONDS * RATE);

  it("loses exactly one fade per seam and nothing else", () => {
    const out = crossfadeConcat([tone(1, 0.5), tone(0.5, 1), tone(1, 0.25)]);
    expect(pcmLength(out)).toBe(Math.round(2.5 * RATE) - 2 * fadeSamples);
  });

  it("drops empty parts, so head/fragment/tail needs no edge cases", () => {
    const out = crossfadeConcat([tone(0, 0), tone(1, 0.5), tone(0, 0)]);
    expect(pcmLength(out)).toBe(RATE);
    expect(out.channels[0][10]).toBeCloseTo(0.5, 6);
  });

  it("actually crossfades: the seam is monotonic between the two levels", () => {
    const out = crossfadeConcat([tone(0.5, 0), tone(0.5, 1)]);
    const seam = Math.round(0.5 * RATE) - fadeSamples;
    const win = Array.from(out.channels[0].subarray(seam, seam + fadeSamples));
    expect(win[0]).toBeGreaterThan(0);
    expect(win[win.length - 1]).toBeLessThan(1);
    for (let i = 1; i < win.length; i++) expect(win[i]).toBeGreaterThan(win[i - 1]);
  });

  it("never lets the fade eat a whole short fragment", () => {
    // A one-word retake can be shorter than the fade itself; the seam shrinks
    // instead of consuming the fragment.
    const tiny = tone(0.004, 1);
    const out = crossfadeConcat([tone(0.5, 0.2), tiny]);
    expect(pcmLength(out)).toBeGreaterThanOrEqual(Math.round(0.5 * RATE));
  });

  it("refuses a sample-rate mismatch rather than changing the pitch", () => {
    expect(() => crossfadeConcat([tone(0.2, 0.5, 8000), tone(0.2, 0.5, 24000)]))
      .toThrow(/sample-rate mismatch/);
  });

  it("refuses to splice nothing", () => {
    expect(() => crossfadeConcat([tone(0, 0)])).toThrow(/nothing to splice/);
  });

  it("splices a mono fragment into a stereo take without silencing a channel", () => {
    const stereo: Pcm = {
      channels: [new Float32Array(RATE).fill(0.4), new Float32Array(RATE).fill(0.6)],
      sampleRate: RATE,
    };
    const out = crossfadeConcat([stereo, tone(0.5, 1)]);
    expect(out.channels).toHaveLength(2);
    const tailStart = RATE + 10;
    expect(out.channels[0][tailStart]).toBeCloseTo(1, 6);
    expect(out.channels[1][tailStart]).toBeCloseTo(1, 6);
  });
});

describe("encodeWav", () => {
  it("writes a header that matches its own payload", () => {
    const p = tone(0.5, 0.5, 24000);
    return encodeWav(p).arrayBuffer().then((buf) => {
      const h = readWav(buf);
      expect([h.riff, h.wave, h.fmt.trim(), h.data]).toEqual(["RIFF", "WAVE", "fmt", "data"]);
      expect(h.format).toBe(1);
      expect(h.bits).toBe(16);
      expect(h.channels).toBe(1);
      expect(h.sampleRate).toBe(24000);
      expect(h.byteRate).toBe(24000 * 2);
      expect(h.blockAlign).toBe(2);
      expect(h.dataSize).toBe(12000 * 2);
      // The chunk sizes and the actual byte count agree — the whole point.
      expect(buf.byteLength).toBe(44 + h.dataSize);
      expect(h.riffSize).toBe(36 + h.dataSize);
    });
  });

  it("interleaves channels frame by frame", async () => {
    const p: Pcm = {
      channels: [new Float32Array([1, 1]), new Float32Array([-1, -1])],
      sampleRate: RATE,
    };
    const h = readWav(await encodeWav(p).arrayBuffer());
    expect(h.channels).toBe(2);
    expect(h.sampleAt(0)).toBe(32767);
    expect(h.sampleAt(1)).toBe(-32768);
    expect(h.sampleAt(2)).toBe(32767);
    expect(h.sampleAt(3)).toBe(-32768);
  });

  it("clamps a summed crossfade instead of wrapping it into a click", async () => {
    const p: Pcm = { channels: [new Float32Array([1.8, -1.8])], sampleRate: RATE };
    const h = readWav(await encodeWav(p).arrayBuffer());
    expect(h.sampleAt(0)).toBe(32767);
    expect(h.sampleAt(1)).toBe(-32768);
  });

  it("refuses an impossible sample rate", () => {
    expect(() => encodeWav({ channels: [new Float32Array(2)], sampleRate: 0 })).toThrow(/sample rate/);
  });

  it("encodes an empty buffer as a valid, empty WAV", async () => {
    const buf = await encodeWav({ channels: [new Float32Array(0)], sampleRate: RATE }).arrayBuffer();
    expect(buf.byteLength).toBe(44);
    expect(readWav(buf).dataSize).toBe(0);
  });
});

describe("peaks", () => {
  it("normalises to the loudest bar and floors silence", () => {
    const data = new Float32Array(560);
    data.fill(0.1);
    data.fill(0.8, 0, 10);
    const peaks = peaksFromSamples(data, 56);
    expect(peaks).toHaveLength(56);
    expect(Math.max(...peaks)).toBeCloseTo(1, 6);
    expect(Math.min(...peaks)).toBeGreaterThanOrEqual(0.06);
  });

  it("reads channel 0 of a Pcm", () => {
    expect(peaksFromPcm(tone(1, 0.5), 8)).toHaveLength(8);
  });
});
