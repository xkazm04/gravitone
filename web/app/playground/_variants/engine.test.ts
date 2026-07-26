import { describe, expect, it, vi, afterEach } from "vitest";
import { EngineBusyError, isAbort, perform, speak } from "./engine";
import { DEFAULT_EXPRESSION } from "./shared";

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
