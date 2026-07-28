// The studio's route handlers had no tests at all: every proxy guarantee
// (forwarded headers, status passthrough, Retry-After, the body cap) lived only
// in a comment. These drive the real handler with `fetch` stubbed at the
// backend boundary, so what is asserted is what a browser would actually
// receive.
//
// /api/speak and /api/performance are the same helper (lib/backend#proxyWavPost)
// pointed at two upstream paths, so both are exercised here.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { POST as speakPOST } from "./route";
import { POST as performancePOST } from "../performance/route";

afterEach(() => { vi.unstubAllGlobals(); });

/** A request to the route, typed as the handler wants it. Route handlers only
 *  ever touch the standard Request surface (headers + text). */
function post(body: unknown, url = "http://studio.local/api/speak"): NextRequest {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function upstreamWav(headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(44), {
    status: 200,
    headers: { "Content-Type": "audio/wav", ...headers },
  });
}

function stubFetch(res: Response | Error) {
  const fn = vi.fn((..._args: unknown[]) => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res)));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("/api/speak — header forwarding", () => {
  it("forwards X-Synth-Segments, which no route used to pass through", async () => {
    // The regression this whole direction exists for: /v1/speak emits it, and
    // all three proxy allowlists omitted it, so it never reached a browser.
    stubFetch(upstreamWav({ "X-Synth-Segments": "4", "X-Audio-Seconds": "3.2" }));
    const res = await speakPOST(post({ character_id: "sarah", text: "hi" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Synth-Segments")).toBe("4");
    expect(res.headers.get("X-Audio-Seconds")).toBe("3.2");
  });

  it("forwards the full exposed set, including headers no allowlist named", async () => {
    stubFetch(upstreamWav({
      "X-Segments": "eyJhIjoxfQ==",
      "X-Ignored-Settings": "style,similarity_boost",
      "X-Queue-Seconds": "0.4",
      "X-Realtime-Factor": "1.9",
      "X-Synth-Seconds": "1.7",
      "X-Sample-Rate": "24000",
      "X-Cache": "hit",
    }));
    const res = await speakPOST(post({ character_id: "sarah", text: "hi" }));
    for (const [h, v] of Object.entries({
      "X-Segments": "eyJhIjoxfQ==", "X-Ignored-Settings": "style,similarity_boost",
      "X-Queue-Seconds": "0.4", "X-Realtime-Factor": "1.9", "X-Synth-Seconds": "1.7",
      "X-Sample-Rate": "24000", "X-Cache": "hit",
    })) {
      expect(res.headers.get(h), h).toBe(v);
    }
  });

  it("omits a header the backend did not send — never an empty string", async () => {
    stubFetch(upstreamWav());
    const res = await speakPOST(post({ character_id: "sarah", text: "hi" }));
    expect(res.headers.has("X-Audio-Seconds")).toBe(false);
    expect(res.headers.get("X-Segments")).toBeNull();
  });

  it("does not leak an upstream header outside the exposed set", async () => {
    stubFetch(upstreamWav({ "X-Internal-Trace": "secret" }));
    const res = await speakPOST(post({ character_id: "sarah", text: "hi" }));
    expect(res.headers.has("X-Internal-Trace")).toBe(false);
  });
});

describe("/api/speak — failure surfaces", () => {
  it("preserves a 429 and its Retry-After instead of flattening it", async () => {
    stubFetch(new Response(JSON.stringify({ detail: "queue full" }), {
      status: 429, headers: { "Retry-After": "7" },
    }));
    const res = await speakPOST(post({ character_id: "sarah", text: "hi" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
    expect(await res.json()).toEqual({ detail: "queue full" });
  });

  it("answers 503 with a JSON detail when the backend is unreachable", async () => {
    stubFetch(new TypeError("connect ECONNREFUSED"));
    const res = await speakPOST(post({ character_id: "sarah", text: "hi" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: "backend unreachable" });
  });

  it("rejects an oversize body with 413 before calling the backend", async () => {
    const fetchMock = stubFetch(upstreamWav());
    const huge = { character_id: "sarah", text: "x".repeat(200_000) };
    const res = await speakPOST(post(huge));
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("/api/speak — output_format", () => {
  it("forwards output_format to the service", async () => {
    const fetchMock = stubFetch(new Response(new Uint8Array(4), {
      status: 200, headers: { "Content-Type": "audio/mpeg" },
    }));
    const res = await speakPOST(post({ character_id: "sarah", text: "hi" },
      "http://studio.local/api/speak?output_format=mp3_24000_128"));
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/speak?output_format=mp3_24000_128");
    // The response says what it IS. Hardcoded audio/wav mislabelled the mp3.
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
  });

  it("builds the SAME upstream URL as before when no format is asked for", async () => {
    const fetchMock = stubFetch(upstreamWav());
    await speakPOST(post({ character_id: "sarah", text: "hi" }));
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/v1\/speak$/);
  });

  it("ignores query parameters outside the forwarded allowlist", async () => {
    const fetchMock = stubFetch(upstreamWav());
    await speakPOST(post({ character_id: "sarah", text: "hi" },
      "http://studio.local/api/speak?output_format=wav_24000&debug=1&voice_id=evil"));
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("output_format=wav_24000");
    expect(url).not.toContain("debug");
    expect(url).not.toContain("voice_id");
  });

  it("lets the service reject an unsupported format instead of guessing", async () => {
    // _parse_format 400s with the list of what IS supported; the proxy must
    // pass that answer through rather than substituting a format nobody asked for.
    stubFetch(new Response(JSON.stringify({ detail: "unsupported output_format 'flac'" }), { status: 400 }));
    const res = await speakPOST(post({ character_id: "sarah", text: "hi" },
      "http://studio.local/api/speak?output_format=flac"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "unsupported output_format 'flac'" });
  });
});

describe("/api/performance", () => {
  it("hits /v1/performance and forwards its report header", async () => {
    const fetchMock = stubFetch(upstreamWav({ "X-Performance-Report": "W10=", "X-Synth-Segments": "9" }));
    const res = await performancePOST(
      post({ lines: [{ character_id: "sarah", text: "hi" }] }, "http://studio.local/api/performance"));
    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/performance");
    expect(res.headers.get("X-Performance-Report")).toBe("W10=");
    expect(res.headers.get("X-Synth-Segments")).toBe("9");
  });

  it("forwards output_format on the route that makes the biggest files", async () => {
    const fetchMock = stubFetch(new Response(new Uint8Array(4), {
      status: 200, headers: { "Content-Type": "audio/mpeg" },
    }));
    const res = await performancePOST(post({ lines: [{ character_id: "sarah", text: "hi" }] },
      "http://studio.local/api/performance?output_format=mp3_24000_128"));
    expect(String(fetchMock.mock.calls[0][0]))
      .toContain("/v1/performance?output_format=mp3_24000_128");
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
  });
});
