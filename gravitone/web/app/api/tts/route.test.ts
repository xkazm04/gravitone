// /api/tts is the drop-in relay (upstream /v1/text-to-speech). It is the only
// route whose upstream emits X-Cache, and its hand-kept two-header allowlist
// dropped it — while writing "" for the two headers it did name.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { POST } from "./route";

afterEach(() => { vi.unstubAllGlobals(); });

function post(body: unknown): NextRequest {
  return new Request("http://studio.local/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function stubFetch(res: Response | Error) {
  const fn = vi.fn((..._args: unknown[]) => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res)));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const wav = (headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(44), { status: 200, headers: { "Content-Type": "audio/wav", ...headers } });

describe("/api/tts", () => {
  it("forwards X-Cache — the one header only this upstream emits", async () => {
    stubFetch(wav({ "X-Cache": "hit", "X-Sample-Rate": "24000", "X-Audio-Seconds": "1.1" }));
    const res = await POST(post({ text: "hello" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("hit");
    expect(res.headers.get("X-Sample-Rate")).toBe("24000");
    expect(res.headers.get("X-Audio-Seconds")).toBe("1.1");
  });

  it("omits a missing header rather than sending it as an empty string", async () => {
    // The old route set X-Audio-Seconds to "" — a client reading it got "" and
    // Number("") === 0, i.e. a confident zero for "the backend said nothing".
    stubFetch(wav());
    const res = await POST(post({ text: "hello" }));
    expect(res.headers.has("X-Audio-Seconds")).toBe(false);
    expect(res.headers.has("X-Realtime-Factor")).toBe(false);
  });

  it("maps the playground voice id onto the backend voice", async () => {
    const fetchMock = stubFetch(wav());
    await POST(post({ text: "hello", voiceId: "mine" }));
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/text-to-speech/step4");
  });

  it("rejects empty text with 400 without calling the backend", async () => {
    const fetchMock = stubFetch(wav());
    const res = await POST(post({ text: "   " }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "empty text" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a 429 and its Retry-After", async () => {
    stubFetch(new Response(JSON.stringify({ detail: "queue full" }), {
      status: 429, headers: { "Retry-After": "3" },
    }));
    const res = await POST(post({ text: "hello" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3");
  });

  it("answers 503 JSON when the backend is unreachable", async () => {
    stubFetch(new TypeError("network"));
    const res = await POST(post({ text: "hello" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: "backend unreachable" });
  });
});
