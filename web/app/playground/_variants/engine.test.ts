import { describe, expect, it, vi, afterEach } from "vitest";
import {
  EngineBusyError, isAbort, perform, refinePeaks, speak, spliceRegion, transcribeWords, uploadTake,
} from "./engine";
import { DEFAULT_EXPRESSION, type Segment, type Take } from "./shared";

const EXPR = DEFAULT_EXPRESSION;

function wavResponse(): Response {
  // 44-byte RIFF header is enough for the result builder.
  return new Response(new Uint8Array(44), {
    status: 200,
    headers: { "Content-Type": "audio/wav", "X-Audio-Seconds": "1.5" },
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("speak — why we fell back", () => {
  it("marks a transport failure 'unreachable'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    const r = await speak("hi", "sarah", EXPR);
    expect(r.mode).toBe("browser");
    expect(r.fallbackReason).toBe("unreachable");
  });

  it("marks a 500 'failed' — NOT unreachable", async () => {
    // The bug: a reachable engine that errored was reported to the user as
    // "Gravitone backend unreachable", which is simply not what happened.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "synthesis failed (request ab12)" }), { status: 500 })));
    const r = await speak("hi", "sarah", EXPR);
    expect(r.mode).toBe("browser");
    expect(r.fallbackReason).toBe("failed");
  });

  it("marks a 503 'draining' — the backend is coming back", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "server shutting down" }), { status: 503 })));
    const r = await speak("hi", "sarah", EXPR);
    expect(r.fallbackReason).toBe("draining");
  });

  it("carries the backend's sanitized detail (request id) onto the take", async () => {
    // The whole point of service/errors.py::sanitized_500 is the correlation
    // id; dropping it left every failure reading as one generic sentence.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "synthesis failed (request ab12)" }), { status: 500 })));
    const r = await speak("hi", "sarah", EXPR);
    expect(r.fallbackDetail).toBe("synthesis failed (request ab12)");
  });

  it("reads a proxy 'backend unreachable' 503 apart from a draining engine", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "backend unreachable" }), { status: 503 })));
    expect((await speak("hi", "sarah", EXPR)).fallbackReason).toBe("unreachable");
  });

  it("throws on a 404 unknown character instead of faking a browser take", async () => {
    // Silently speaking the line in a browser voice hid a roster that no longer
    // matches the backend — the user must be told the Character is gone.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "unknown character 'sarah'" }), { status: 404 })));
    await expect(speak("hi", "sarah", EXPR)).rejects.toMatchObject({
      name: "ApiError", status: 404, message: "unknown character 'sarah'",
    });
  });

  it("throws EngineBusyError on 429 instead of falling back at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("{}", { status: 429, headers: { "Retry-After": "3" } })));
    await expect(speak("hi", "sarah", EXPR)).rejects.toBeInstanceOf(EngineBusyError);
  });

  it("returns a gravitone take on success with no fallback reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(wavResponse()));
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    const r = await speak("hi", "sarah", EXPR);
    expect(r.mode).toBe("gravitone");
    expect(r.fallbackReason).toBeUndefined();
  });
});

describe("speak — cancellation", () => {
  it("propagates an abort instead of fabricating a browser take", async () => {
    // A user-initiated cancel is not a backend failure; inventing a
    // browser-voice take for it would be the same class of lie.
    const err = new DOMException("aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
    await expect(speak("hi", "sarah", EXPR, AbortSignal.abort())).rejects.toBe(err);
  });

  it("passes the signal through to fetch", async () => {
    const f = vi.fn().mockResolvedValue(wavResponse());
    vi.stubGlobal("fetch", f);
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    const ctrl = new AbortController();
    await speak("hi", "sarah", EXPR, ctrl.signal);
    expect(f.mock.calls[0][1]).toMatchObject({ signal: ctrl.signal });
  });
});

describe("perform — same contract as speak", () => {
  const LINES = [{ character_id: "sarah", text: "one" }];

  it("marks a 500 'failed'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));
    expect((await perform(LINES, EXPR)).fallbackReason).toBe("failed");
  });

  it("marks a transport failure 'unreachable'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    expect((await perform(LINES, EXPR)).fallbackReason).toBe("unreachable");
  });

  it("propagates an abort", async () => {
    const err = new DOMException("aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
    await expect(perform(LINES, EXPR, AbortSignal.abort())).rejects.toBe(err);
  });

  it("throws on a 404 unknown character in a line", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "unknown character 'sarah' (line 0)" }), { status: 404 })));
    await expect(perform(LINES, EXPR)).rejects.toMatchObject({ status: 404 });
  });
});

describe("isAbort", () => {
  it("recognises a DOMException AbortError", () => {
    expect(isAbort(new DOMException("x", "AbortError"))).toBe(true);
  });
  it("recognises a plain object with the same name (node/jsdom shapes vary)", () => {
    expect(isAbort({ name: "AbortError" })).toBe(true);
  });
  it("is false for other failures", () => {
    expect(isAbort(new TypeError("network"))).toBe(false);
    expect(isAbort(null)).toBe(false);
  });
});

describe("the take carries its own audio", () => {
  it("returns the synthesized blob instead of only an object URL", async () => {
    // persistTake and uploadTake each used to fetch() the take's own object URL
    // to get these exact bytes back — two extra copies of the whole WAV.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(wavResponse()));
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    const r = await speak("hi", "sarah", EXPR);
    expect(r.blob).toBeInstanceOf(Blob);
    expect(r.blob!.size).toBe(44);
  });

  it("does not wait for a waveform decode before returning the take", async () => {
    // jsdom has no AudioContext, so a decode inside synthesis would have to be
    // caught; the take now ships with synthetic bars and is refined later.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(wavResponse()));
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    const r = await speak("hi", "sarah", EXPR);
    expect(r.peaks).toHaveLength(56);
    expect(r.mode).toBe("gravitone");
  });

  it("refinePeaks degrades to null rather than costing the user the take", async () => {
    expect(await refinePeaks(new Blob([new Uint8Array(44)]))).toBeNull();
  });
});

describe("uploadTake", () => {
  const take = (over: Partial<Take> = {}): Take => ({
    id: "take-1", text: "hi", characterId: "sarah", characterName: "Sarah",
    mode: "gravitone", url: "blob:x", blob: new Blob([new Uint8Array(8)]),
    peaks: [], seconds: 1, kb: 1, rtf: 1, synthSeconds: 0, queueSeconds: 0,
    ignoredSettings: [], segments: [], expr: EXPR, createdAt: 1, ...over,
  });

  it("publishes the take's own blob — never re-fetching the object URL", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ take_id: "t1" }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    expect(await uploadTake(take())).toBe("t1");
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe("/api/takes");
  });

  it("throws the backend's detail so the caller can show it", async () => {
    // share()'s catch had nothing to show because this threw a generic message.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "take store full (request cd34)" }), { status: 500 })));
    await expect(uploadTake(take())).rejects.toMatchObject({
      message: "take store full (request cd34)",
    });
  });

  it("refuses a browser-fallback take (there is no audio to publish)", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(uploadTake(take({ url: undefined, blob: undefined }))).rejects.toThrow(/cannot be shared/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("output format", () => {
  // jsdom has no object-URL support; the result builder mints one for every
  // successful take.
  const stubObjectUrl = () =>
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => {} });

  it("asks /api/speak for the requested format and stamps it on the take", async () => {
    const f = vi.fn().mockResolvedValue(new Response(new Uint8Array(4), {
      status: 200, headers: { "Content-Type": "audio/mpeg", "X-Audio-Seconds": "2" },
    }));
    vi.stubGlobal("fetch", f);
    stubObjectUrl();
    const r = await speak("hi", "sarah", EXPR, undefined, "mp3_24000_128");
    expect(String(f.mock.calls[0][0])).toBe("/api/speak?output_format=mp3_24000_128");
    expect(r.format).toBe("mp3_24000_128");
  });

  it("defaults to wav_24000 so an unchanged caller renders unchanged audio", async () => {
    const f = vi.fn().mockResolvedValue(wavResponse());
    vi.stubGlobal("fetch", f);
    stubObjectUrl();
    const r = await speak("hi", "sarah", EXPR);
    expect(String(f.mock.calls[0][0])).toBe("/api/speak?output_format=wav_24000");
    expect(r.format).toBe("wav_24000");
  });

  it("carries the format through a performance too", async () => {
    const f = vi.fn().mockResolvedValue(new Response(new Uint8Array(4), {
      status: 200, headers: { "Content-Type": "audio/mpeg" },
    }));
    vi.stubGlobal("fetch", f);
    stubObjectUrl();
    const r = await perform([{ character_id: "sarah", text: "hi" }], EXPR, undefined, "mp3_24000_128");
    expect(String(f.mock.calls[0][0])).toBe("/api/performance?output_format=mp3_24000_128");
    expect(r.format).toBe("mp3_24000_128");
  });

  it("reports the browser fallback as wav — it has no file at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    expect((await speak("hi", "sarah", EXPR, undefined, "mp3_24000_128")).format).toBe("wav_24000");
  });

  it("decodes X-Synth-Segments now that the proxy forwards it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array(44), {
      status: 200, headers: { "Content-Type": "audio/wav", "X-Synth-Segments": "6" },
    })));
    stubObjectUrl();
    expect((await speak("hi", "sarah", EXPR)).synthSegments).toBe(6);
  });
});

// ── the splice kernel ────────────────────────────────────────────────────────
// jsdom has no AudioContext at all, so the ONE browser dependency here
// (decodeAudioData) is faked: it returns the buffer matching the blob's marker
// byte, which keeps base-vs-fragment deterministic whatever order the two
// decodes settle in. The context is a single object because engine.ts caches one
// for the page's lifetime — the fake has to behave the same way.

const RATE = 8000;

class FakeBuffer {
  constructor(readonly chans: Float32Array[], readonly sampleRate: number) {}
  get numberOfChannels() { return this.chans.length; }
  get length() { return this.chans[0].length; }
  get duration() { return this.length / this.sampleRate; }
  getChannelData(i: number) { return this.chans[i]; }
}

let decodeTable: Record<number, FakeBuffer | "fail"> = {};
const fakeCtx = {
  state: "running" as AudioContextState,
  resume: () => Promise.resolve(),
  async decodeAudioData(buf: ArrayBuffer) {
    const found = decodeTable[new Uint8Array(buf)[0]];
    if (!found || found === "fail") throw new Error("could not decode");
    return found as unknown as AudioBuffer;
  },
};

/** A blob whose first byte says which fake buffer it decodes to. */
function marked(mark: number): Blob {
  return new Blob([new Uint8Array([mark, 0, 0, 0])]);
}

function fakeAudio(table: Record<number, FakeBuffer | "fail">) {
  decodeTable = table;
  vi.stubGlobal("AudioContext", function AC() { return fakeCtx; } as unknown as typeof AudioContext);
}

describe("spliceRegion", () => {
  const seg = (text: string, seconds: number, over: Partial<Segment> = {}): Segment => ({
    text, requested: "baseline", used: "baseline", fallback: false,
    voice_id: "v1", seconds, ...over,
  });

  const base = (over: Partial<Take> = {}): Take => ({
    id: "take-base", text: "one two three", characterId: "sarah", characterName: "Sarah",
    mode: "gravitone", url: "blob:base", blob: marked(1),
    peaks: [], seconds: 3, kb: 10, rtf: 1, synthSeconds: 1, queueSeconds: 0,
    ignoredSettings: [], segments: [seg("one", 1), seg("two", 1), seg("three", 1)],
    expr: EXPR, createdAt: 1, ...over,
  });

  const threeSeconds = () => new FakeBuffer([new Float32Array(3 * RATE).fill(0.5)], RATE);
  const twoSeconds = () => new FakeBuffer([new Float32Array(2 * RATE).fill(0.9)], RATE);

  it("replaces the middle region and masters a longer wav", async () => {
    fakeAudio({ 1: threeSeconds(), 2: twoSeconds() });
    const r = await spliceRegion({
      base: base(), regionIndex: 1, fragment: marked(2), fragmentSegments: [],
    });
    expect(r).not.toBeNull();
    // 1s head + 2s fragment + 1s tail, minus two 12 ms crossfades.
    expect(r!.seconds).toBeCloseTo(4, 1);
    expect(r!.blob.type).toBe("audio/wav");
    expect(r!.blob.size).toBeGreaterThan(44);
    expect(r!.peaks).toHaveLength(56);
    // The patched region's own bounds, so the caller can play just the edit.
    expect(r!.start).toBeCloseTo(1, 2);
    expect(r!.end).toBeCloseTo(3, 2);
  });

  it("uses the DECODED duration as truth, not the take's header seconds", async () => {
    // The header claims 30s; the samples say 3. A splice that trusted the header
    // would cut its boundaries a factor of ten out.
    fakeAudio({ 1: threeSeconds(), 2: twoSeconds() });
    const r = await spliceRegion({
      base: base({ seconds: 30 }), regionIndex: 0, fragment: marked(2), fragmentSegments: [],
    });
    expect(r!.seconds).toBeCloseTo(4, 1);
    expect(r!.start).toBe(0);
  });

  it("patches the segment report with the fragment's real length", async () => {
    fakeAudio({ 1: threeSeconds(), 2: twoSeconds() });
    const r = await spliceRegion({
      base: base(), regionIndex: 1, fragment: marked(2), fragmentSegments: [],
    });
    expect(r!.segments).toHaveLength(3);
    expect(r!.segments[1].seconds).toBeCloseTo(2, 2);
    expect(r!.segments.map((s) => s.text)).toEqual(["one", "two", "three"]);
  });

  it("splices a MULTI-segment fragment in, re-based onto its decoded length", async () => {
    fakeAudio({ 1: threeSeconds(), 2: twoSeconds() });
    const r = await spliceRegion({
      base: base(), regionIndex: 1, fragment: marked(2),
      fragmentSegments: [seg("two", 1, { used: "sad" }), seg("again", 3, { used: "sad" })],
    });
    expect(r!.segments.map((s) => s.text)).toEqual(["one", "two", "again", "three"]);
    // Reported 1 + 3, decoded 2 → 0.5 + 1.5.
    expect(r!.segments[1].seconds + r!.segments[2].seconds).toBeCloseTo(2, 2);
  });

  it("keeps the replaced segment's Character and source line", async () => {
    // A punched performance take must stay attributable line by line.
    fakeAudio({ 1: threeSeconds(), 2: twoSeconds() });
    const perf = base({
      segments: [
        seg("one", 1, { characterId: "sarah", line: 0 }),
        seg("two", 1, { characterId: "bo", line: 1 }),
        seg("three", 1, { characterId: "sarah", line: 2 }),
      ],
    });
    const r = await spliceRegion({
      base: perf, regionIndex: 1, fragment: marked(2), fragmentSegments: [seg("two", 1)],
    });
    expect(r!.segments[1].characterId).toBe("bo");
    expect(r!.segments[1].line).toBe(1);
  });

  it("degrades to null when the take will not decode — never costs the take", async () => {
    // The refinePeaks contract: a decode hiccup leaves the user's take exactly
    // where it was, and the console offers a full re-render instead.
    fakeAudio({ 1: "fail", 2: twoSeconds() });
    expect(await spliceRegion({
      base: base(), regionIndex: 1, fragment: marked(2), fragmentSegments: [],
    })).toBeNull();
  });

  it("degrades to null when the FRAGMENT will not decode", async () => {
    fakeAudio({ 1: threeSeconds(), 2: "fail" });
    expect(await spliceRegion({
      base: base(), regionIndex: 1, fragment: marked(2), fragmentSegments: [],
    })).toBeNull();
  });

  it("refuses a take with no audio, and a region that does not exist", async () => {
    fakeAudio({ 1: threeSeconds(), 2: twoSeconds() });
    expect(await spliceRegion({
      base: base({ blob: undefined }), regionIndex: 0, fragment: marked(2), fragmentSegments: [],
    })).toBeNull();
    expect(await spliceRegion({
      base: base(), regionIndex: 9, fragment: marked(2), fragmentSegments: [],
    })).toBeNull();
  });
});

describe("transcribeWords", () => {
  it("posts the take to /api/stt and keeps only usable word timings", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      text: "one two",
      words: [
        { text: "one", start: 0, end: 0.4, type: "word" },
        { text: "two", start: 0.4, end: 0.9 },
        { text: "", start: 1, end: 2 },
        { text: "broken" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", f);
    const got = await transcribeWords(new Blob(["wav"]));
    expect(f.mock.calls[0][0]).toBe("/api/stt");
    expect(f.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(got.text).toBe("one two");
    expect(got.words).toEqual([
      { text: "one", start: 0, end: 0.4 },
      { text: "two", start: 0.4, end: 0.9 },
    ]);
  });

  it("throws the service's own answer when whisper is not installed", async () => {
    // A 503 with the install hint is a legitimate state on a fresh box; the
    // caller keeps offering segment-level punch-in.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: "local speech-to-text needs faster-whisper" }), { status: 503 })));
    await expect(transcribeWords(new Blob(["wav"]))).rejects.toMatchObject({
      message: "local speech-to-text needs faster-whisper",
    });
  });
});
