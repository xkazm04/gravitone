// The streaming relay. What is under test is the part that cannot be inspected
// from a comment: that the response is available BEFORE the upstream body ends
// (buffering here silently turns the feature back into /api/speak), and that
// the upstream URL addresses the Character's baseline voice rather than
// whatever string a caller put in the body.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { POST } from "./route";

afterEach(() => { vi.unstubAllGlobals(); });

function post(body: unknown): NextRequest {
  return new Request("http://studio.local/api/speak/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function stubFetch(res: Response | Error) {
  const fn = vi.fn((..._args: unknown[]) =>
    res instanceof Error ? Promise.reject(res) : Promise.resolve(res));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** An upstream whose body is still open — the shape the service actually
 *  produces, and the one a buffering relay hangs on. */
function openStream(headers: Record<string, string> = {}) {
  let push!: (b: Uint8Array) => void;
  let finish!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(c) { push = (b) => c.enqueue(b); finish = () => c.close(); },
  });
  return {
    push, finish,
    response: new Response(body, {
      status: 200,
      headers: { "Content-Type": "audio/pcm", "X-Stream": "true", ...headers },
    }),
  };
}

const OK = { character_id: "sarah", text: "hello there" };

describe("/api/speak/stream — the relay does not hold the take", () => {
  it("answers while the upstream is STILL SENDING, then delivers in order", async () => {
    // The whole feature. If this handler ever awaits the body, this test hangs
    // rather than failing quietly with a still-correct-looking response.
    const up = openStream({ "X-Sample-Rate": "24000", "X-Stream-Segments": "3" });
    stubFetch(up.response);

    const res = await POST(post(OK));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Sample-Rate")).toBe("24000");
    expect(res.headers.get("X-Stream-Segments")).toBe("3");

    up.push(new Uint8Array([1, 2]));
    up.push(new Uint8Array([3, 4]));
    up.finish();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("addresses the Character's BASELINE voice and pins pcm_24000", async () => {
    // The streaming route has no metatag grammar, so it is only ever handed
    // untagged text and only ever addressed at one voice; pcm is what the
    // browser decodes and masters itself.
    const f = stubFetch(openStream().response);
    await POST(post(OK));
    expect(String(f.mock.calls[0][0]))
      .toContain("/v1/text-to-speech/sarah%3Abaseline/stream?output_format=pcm_24000");
  });

  it("forwards the voice settings and nothing else the caller invented", async () => {
    const f = stubFetch(openStream().response);
    await POST(post({ ...OK, voice_settings: { temperature: 0.9 }, cache: false }));
    expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body))).toEqual({
      text: "hello there", voice_settings: { temperature: 0.9 },
    });
  });
});

describe("/api/speak/stream — refusals", () => {
  it("refuses a character_id that would reshape the upstream path", async () => {
    // ':' is the emotion-address separator and '/' is a path segment; either
    // one in a caller's string is a request to address something else.
    const f = stubFetch(openStream().response);
    for (const character_id of ["sarah:angry", "../voices", ""]) {
      const res = await POST(post({ ...OK, character_id }));
      expect(res.status).toBe(400);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses an empty or over-long text before spending a worker slot", async () => {
    const f = stubFetch(openStream().response);
    expect((await POST(post({ ...OK, text: "  " }))).status).toBe(400);
    expect((await POST(post({ ...OK, text: "x".repeat(8001) }))).status).toBe(413);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON rather than 500ing", async () => {
    const req = new Request("http://studio.local/api/speak/stream", {
      method: "POST", body: "not json",
    }) as unknown as NextRequest;
    expect((await POST(req)).status).toBe(400);
  });

  it("preserves a 429 and its Retry-After — backpressure survives the relay", async () => {
    stubFetch(new Response(JSON.stringify({ detail: "queue full" }), {
      status: 429, headers: { "Retry-After": "7" },
    }));
    const res = await POST(post(OK));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
    expect((await res.json()).detail).toBe("queue full");
  });

  it("answers one JSON shape when the backend cannot be reached", async () => {
    stubFetch(new TypeError("connect ECONNREFUSED"));
    const res = await POST(post(OK));
    expect(res.status).toBe(503);
    expect((await res.json()).detail).toBe("backend unreachable");
  });
});
