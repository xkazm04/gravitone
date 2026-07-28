import { describe, expect, it, vi, afterEach } from "vitest";
import { EngineBusyError, isAbort, perform, refinePeaks, speak, uploadTake } from "./engine";
import { DEFAULT_EXPRESSION, type Take } from "./shared";

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
