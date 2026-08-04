import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineBusyError, EngineDegraded, ServerEngine, getEngine, isAbort, registerEngine,
  type SpeechEngineClient, type SynthesisRequest, type TakeAudio,
} from "./engineSeam";

// The conformance suite for the ONE real engine. It is deliberately written
// against the INTERFACE rather than against ServerEngine's internals, so the
// day a LocalEngine exists this file is the contract it has to satisfy too.

const SETTINGS = { temperature: 0.7, stability: 0, quality: 1 };

function audioResponse(headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(44), {
    status: 200,
    headers: { "Content-Type": "audio/wav", "X-Audio-Seconds": "1.5", ...headers },
  });
}

function b64(v: unknown): string {
  return btoa(JSON.stringify(v));
}

const stubObjectUrl = () =>
  vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => {} });

afterEach(() => { vi.unstubAllGlobals(); registerEngine(null); });

const SOLO: SynthesisRequest = {
  kind: "solo", text: "hi", characterId: "sarah", settings: SETTINGS,
};
const PERF: SynthesisRequest = {
  kind: "performance", lines: [{ character_id: "sarah", text: " one " }], settings: SETTINGS,
};
const VOICE: SynthesisRequest = { kind: "voice", text: "hi", voiceId: "v-42" };

describe("ServerEngine — the wire for each call pattern", () => {
  it("sends a solo take to /api/speak with the character and the three knobs", async () => {
    const f = vi.fn().mockResolvedValue(audioResponse());
    vi.stubGlobal("fetch", f);
    stubObjectUrl();
    await new ServerEngine().synthesize({ ...SOLO, format: "mp3_24000_128" });
    expect(String(f.mock.calls[0][0])).toBe("/api/speak?output_format=mp3_24000_128");
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({
      character_id: "sarah", text: "hi", voice_settings: SETTINGS,
    });
  });

  it("sends a performance to /api/performance, trimming each line", async () => {
    const f = vi.fn().mockResolvedValue(audioResponse());
    vi.stubGlobal("fetch", f);
    stubObjectUrl();
    await new ServerEngine().synthesize(PERF);
    expect(String(f.mock.calls[0][0])).toBe("/api/performance?output_format=wav_24000");
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({
      lines: [{ character_id: "sarah", text: "one", voice_settings: SETTINGS }],
    });
  });

  it("sends a raw-voice line to /api/tts and reports wav — that route has no format grammar", async () => {
    const f = vi.fn().mockResolvedValue(audioResponse());
    vi.stubGlobal("fetch", f);
    stubObjectUrl();
    const got = await new ServerEngine().synthesize(VOICE);
    expect(String(f.mock.calls[0][0])).toBe("/api/tts");
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ text: "hi", voiceId: "v-42" });
    expect(got.format).toBe("wav_24000");
  });

  it("renders a punch-in FRAGMENT as a solo request pinned to wav", async () => {
    // The splice kernel masters wav, so the fragment must arrive as wav — the
    // same request PunchIn makes, abortable, with its own segment report which
    // spliceRegion re-bases onto the decoded fragment length.
    const f = vi.fn().mockResolvedValue(audioResponse({
      "X-Segments": b64([{ text: "two", requested: "sad", used: "sad", fallback: false, voice_id: "v1", seconds: 1 }]),
    }));
    vi.stubGlobal("fetch", f);
    stubObjectUrl();
    const ctrl = new AbortController();
    const got = await new ServerEngine().synthesize({
      kind: "solo", text: "[sad] two", characterId: "sarah", settings: SETTINGS,
      format: "wav_24000", signal: ctrl.signal,
    });
    expect(String(f.mock.calls[0][0])).toBe("/api/speak?output_format=wav_24000");
    expect(f.mock.calls[0][1]).toMatchObject({ signal: ctrl.signal });
    expect(got.segments).toEqual([
      { text: "two", requested: "sad", used: "sad", fallback: false, voice_id: "v1", seconds: 1 },
    ]);
  });

  it("defaults to wav so a caller that names no format renders unchanged audio", async () => {
    const f = vi.fn().mockResolvedValue(audioResponse());
    vi.stubGlobal("fetch", f);
    stubObjectUrl();
    expect((await new ServerEngine().synthesize(SOLO)).format).toBe("wav_24000");
    expect(String(f.mock.calls[0][0])).toBe("/api/speak?output_format=wav_24000");
  });
});

describe("ServerEngine — what it reports about the audio", () => {
  it("carries the blob itself, not only an object URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(audioResponse()));
    stubObjectUrl();
    const got = await new ServerEngine().synthesize(SOLO);
    expect(got.blob).toBeInstanceOf(Blob);
    expect(got.blob.size).toBe(44);
    expect(got.url).toBe("blob:x");
  });

  it("decodes the honest timing headers, and reports 0 for the ones absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(audioResponse({
      "X-Realtime-Factor": "3.5", "X-Synth-Seconds": "0.4", "X-Synth-Segments": "6",
      "X-Ignored-Settings": "similarity_boost, style ,",
    })));
    stubObjectUrl();
    const got = await new ServerEngine().synthesize(SOLO);
    expect(got).toMatchObject({
      seconds: 1.5, rtf: 3.5, synthSeconds: 0.4, queueSeconds: 0, synthSegments: 6,
      ignoredSettings: ["similarity_boost", "style"],
    });
  });

  it("decodes the performance report into per-character segments", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(audioResponse({
      "X-Performance-Report": b64([
        { text: "one", requested: "baseline", used: "baseline", fallback: false,
          voice_id: "v1", seconds: 1, character_id: "sarah", line: 0 },
      ]),
    })));
    stubObjectUrl();
    const got = await new ServerEngine().synthesize(PERF);
    expect(got.segments[0]).toMatchObject({ characterId: "sarah", line: 0, text: "one" });
  });

  it("degrades a corrupt segment header to no segments rather than throwing", async () => {
    // A decoration that fails to decode must never cost the caller its audio.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(audioResponse({ "X-Segments": "not-base64!!" })));
    stubObjectUrl();
    expect((await new ServerEngine().synthesize(SOLO)).segments).toEqual([]);
  });

  it("says a corrupt report is CORRUPT — not a single-segment take", async () => {
    // The two used to be one empty array, so a header mangled in transit
    // rendered as an ordinary take that simply never switched emotion.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(audioResponse({ "X-Segments": "not-base64!!" })));
    stubObjectUrl();
    expect((await new ServerEngine().synthesize(SOLO)).reportCorrupt).toBe(true);
  });

  it("says the same for a corrupt performance report", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      audioResponse({ "X-Performance-Report": btoa("{not json") })));
    stubObjectUrl();
    const got = await new ServerEngine().synthesize(PERF);
    expect(got.segments).toEqual([]);
    expect(got.reportCorrupt).toBe(true);
  });

  it("does NOT call a report-less take corrupt", async () => {
    // No header at all is the ordinary shape of a one-segment take.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(audioResponse()));
    stubObjectUrl();
    expect((await new ServerEngine().synthesize(SOLO)).reportCorrupt).toBe(false);
  });

  it("calls a well-formed-but-not-an-array report corrupt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      audioResponse({ "X-Segments": b64({ oops: true }) })));
    stubObjectUrl();
    expect((await new ServerEngine().synthesize(SOLO)).reportCorrupt).toBe(true);
  });
});

describe("ServerEngine — failures the caller must be able to tell apart", () => {
  it("marks a transport failure 'unreachable' with no detail to invent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    const err = await new ServerEngine().synthesize(SOLO).catch((e) => e);
    expect(err).toBeInstanceOf(EngineDegraded);
    expect(err.reason).toBe("unreachable");
    expect(err.detail).toBeUndefined();
  });

  it("marks a 500 'failed' — the engine IS reachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "synthesis failed (request ab12)" }), { status: 500 })));
    const err = await new ServerEngine().synthesize(SOLO).catch((e) => e);
    expect(err.reason).toBe("failed");
    expect(err.detail).toBe("synthesis failed (request ab12)");
    // The detail is the message too, so an unwrapping caller still shows it.
    expect(err.message).toBe("synthesis failed (request ab12)");
  });

  it("reads a draining engine apart from a proxy that cannot reach one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "server shutting down" }), { status: 503 })));
    expect((await new ServerEngine().synthesize(SOLO).catch((e) => e)).reason).toBe("draining");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "backend unreachable" }), { status: 503 })));
    expect((await new ServerEngine().synthesize(SOLO).catch((e) => e)).reason).toBe("unreachable");
  });

  it("throws EngineBusyError on 429 with the Retry-After it was given", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("{}", { status: 429, headers: { "Retry-After": "3" } })));
    const err = await new ServerEngine().synthesize(SOLO).catch((e) => e);
    expect(err).toBeInstanceOf(EngineBusyError);
    expect(err.retryAfterSec).toBe(3);
  });

  it("throws a 404 as an ApiError — a gone Character is never a degrade", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "unknown character 'sarah'" }), { status: 404 })));
    await expect(new ServerEngine().synthesize(SOLO)).rejects.toMatchObject({
      name: "ApiError", status: 404, message: "unknown character 'sarah'",
    });
  });

  it("propagates an abort untouched on every kind", async () => {
    const err = new DOMException("aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
    for (const req of [SOLO, PERF, VOICE]) {
      await expect(new ServerEngine().synthesize(req)).rejects.toBe(err);
    }
  });
});

describe("isAbort", () => {
  it("recognises a DOMException and a bare object with the same name", () => {
    expect(isAbort(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbort({ name: "AbortError" })).toBe(true);
  });
  it("is false for other failures", () => {
    expect(isAbort(new TypeError("network"))).toBe(false);
    expect(isAbort(null)).toBe(false);
  });
});

describe("capabilities", () => {
  it("says the server engine is not on-device and needs a backend", () => {
    const caps = new ServerEngine().capabilities();
    expect(caps).toMatchObject({ id: "server", onDevice: false, requiresBackend: true, streaming: false });
  });

  it("claims every kind the studio actually asks for", () => {
    expect(new ServerEngine().capabilities().kinds).toEqual(["solo", "performance", "voice"]);
  });
});

describe("the registry", () => {
  it("hands out the server engine by default", () => {
    expect(getEngine().capabilities().id).toBe("server");
  });

  it("is the same instance across calls (no engine churn per render)", () => {
    expect(getEngine()).toBe(getEngine());
  });

  it("lets another engine be plugged in — and null restores the server one", () => {
    // The whole point of the seam: a LocalEngine lands HERE, not in a rewrite
    // of every call site.
    const fake: SpeechEngineClient = {
      capabilities: () => ({
        id: "local", label: "this device", kinds: ["solo"], formats: ["wav_24000"],
        onDevice: true, requiresBackend: false, streaming: false,
      }),
      synthesize: async () => ({} as TakeAudio),
    };
    registerEngine(fake);
    expect(getEngine()).toBe(fake);
    expect(getEngine().capabilities().onDevice).toBe(true);
    registerEngine(null);
    expect(getEngine().capabilities().id).toBe("server");
  });
});
