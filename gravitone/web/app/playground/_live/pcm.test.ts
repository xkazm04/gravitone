// The byte layer is where a live conversation fails SILENTLY: a wrong sample
// scale is a quiet agent, a wrong byte order is static, and a wrong WAV header
// is a take the browser refuses to decode — none of which throws. So every
// conversion is pinned here, without an AudioContext in sight.

import { describe, expect, it } from "vitest";
import {
  base64ToPcm16, bytesToPcm16, concatPcm16, encodeWav, floatToPcm16, parseAudioFormat,
  pcm16ToBase64, pcm16ToBytes, pcm16ToFloat, pcmSeconds,
} from "./pcm";

describe("float ↔ pcm16", () => {
  it("scales full-scale samples to the int16 rails", () => {
    const pcm = floatToPcm16(new Float32Array([0, 1, -1, 0.5]));
    expect(Array.from(pcm)).toEqual([0, 32767, -32768, 16384]);
  });

  it("CLIPS a hot sample instead of wrapping it", () => {
    // Wrapping turns a loud syllable into a click — the failure this guards.
    const pcm = floatToPcm16(new Float32Array([1.8, -2.4]));
    expect(Array.from(pcm)).toEqual([32767, -32768]);
  });

  it("round-trips back to float within a sample of quantisation", () => {
    const back = pcm16ToFloat(floatToPcm16(new Float32Array([0.25, -0.75])));
    expect(back[0]).toBeCloseTo(0.25, 4);
    expect(back[1]).toBeCloseTo(-0.75, 4);
  });
});

describe("wire bytes", () => {
  it("writes LITTLE-endian bytes regardless of the host", () => {
    // 0x0100 = 256 → bytes 00 01. Reading the platform's Int16Array buffer
    // instead would produce 01 00 on a big-endian host: static, not a crash.
    expect(Array.from(pcm16ToBytes(new Int16Array([256])))).toEqual([0, 1]);
  });

  it("drops an odd trailing byte rather than inventing a sample", () => {
    expect(Array.from(bytesToPcm16(new Uint8Array([0, 1, 7])))).toEqual([256]);
  });

  it("round-trips PCM through base64 (the `user_audio_chunk` payload)", () => {
    const pcm = new Int16Array([0, 1234, -4321, 32767, -32768]);
    expect(Array.from(base64ToPcm16(pcm16ToBase64(pcm))!)).toEqual(Array.from(pcm));
  });

  it("returns null for an undecodable frame instead of throwing", () => {
    // One malformed frame must drop the frame, never the conversation.
    expect(base64ToPcm16("!!! not base64 !!!")).toBeNull();
  });

  it("survives a frame far larger than the btoa argument limit", () => {
    const pcm = new Int16Array(200_000);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = (i % 3000) - 1500;
    const back = base64ToPcm16(pcm16ToBase64(pcm))!;
    expect(back.length).toBe(pcm.length);
    expect(back[199_999]).toBe(pcm[199_999]);
  });

  it("concatenates turn chunks in order", () => {
    expect(Array.from(concatPcm16([new Int16Array([1, 2]), new Int16Array([3])]))).toEqual([1, 2, 3]);
  });
});

describe("encodeWav", () => {
  it("writes a mono 16-bit RIFF header the decoders expect", async () => {
    const blob = encodeWav(new Int16Array([0, 100, -100]), 16_000);
    expect(blob.type).toBe("audio/wav");
    const view = new DataView(await blob.arrayBuffer());
    const ascii = (at: number, n: number) =>
      String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(at + i)));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);      // PCM
    expect(view.getUint16(22, true)).toBe(1);      // mono
    expect(view.getUint32(24, true)).toBe(16_000); // the CONVERSATION's rate
    expect(view.getUint32(28, true)).toBe(32_000); // byte rate
    expect(view.getUint16(34, true)).toBe(16);     // bits
    expect(ascii(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(6);      // 3 samples × 2 bytes
    expect(view.getUint32(4, true)).toBe(36 + 6);  // RIFF size covers the payload
    expect(view.getInt16(44 + 2, true)).toBe(100); // samples land after 44 bytes
  });
});

describe("durations and formats", () => {
  it("reports seconds at the conversation's rate", () => {
    expect(pcmSeconds(new Int16Array(24_000), 16_000)).toBe(1.5);
    expect(pcmSeconds(new Int16Array(10), 0)).toBe(0);
  });

  it("reads pcm_16000 and never yields 0 (which would NaN every duration)", () => {
    expect(parseAudioFormat("pcm_16000")).toBe(16_000);
    expect(parseAudioFormat("pcm_24000")).toBe(24_000);
    expect(parseAudioFormat(undefined)).toBe(16_000);
    expect(parseAudioFormat("nonsense")).toBe(16_000);
  });
});
