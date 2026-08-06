// The paste-time probe proxy.
//
// Two things it must not do: turn a verdict into an error (a 200 body saying
// "this will be trimmed" is the whole feature), and turn a NAMED refusal into a
// generic one — 403 not-YouTube, 422 private video and 429 with its Retry-After
// are each a different sentence in the paste box.

import { afterEach, expect, it, vi } from "vitest";

import { POST } from "./route";

function stubFetch(reply: () => Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const r = reply();
    if (r instanceof Error) throw r;
    return r;
  }));
  return calls;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...headers },
  });

const post = (body: unknown) =>
  POST(new Request("http://studio.local/api/ingest/link-probe", {
    method: "POST", body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest);

afterEach(() => { vi.unstubAllGlobals(); });

it("relays the link and returns the verdict as-is", async () => {
  const verdict = {
    ok: true, title: "A talk", duration: 2820, clip_seconds: 900, trimmed: true,
    message: "47 minutes video — we'll clone the first 15 minutes.",
    attestation: "I have the right to use this recording and to clone the voice in it.",
  };
  const calls = stubFetch(() => json(verdict));
  const r = await post({ url: "https://youtu.be/abc" });
  expect(calls[0].url).toMatch(/\/v1\/ingest\/link\/probe$/);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual(verdict);
});

it("keeps a refused-but-readable link a 200 verdict, not an error", async () => {
  stubFetch(() => json({
    ok: false, title: "A clip", duration: 2, clip_seconds: null, trimmed: false,
    message: "that video is 2 seconds long — a clone needs at least 3 seconds of speech.",
  }));
  const r = await post({ url: "https://youtu.be/abc" });
  expect(r.status).toBe(200);
  expect((await r.json()).ok).toBe(false);
});

it.each([[403], [422], [503]])("passes a %i refusal through by name", async (status) => {
  stubFetch(() => json({ detail: "that video is private. Download the audio and drop the file instead." }, status));
  const r = await post({ url: "https://youtu.be/abc" });
  expect(r.status).toBe(status);
  expect((await r.json()).detail).toContain("drop the file");
});

it("keeps Retry-After on the budgeted 429", async () => {
  stubFetch(() => json({ detail: "rate-limited" }, 429, { "Retry-After": "17" }));
  const r = await post({ url: "https://youtu.be/abc" });
  expect(r.headers.get("Retry-After")).toBe("17");
});

it("says the backend is unreachable rather than inventing a verdict", async () => {
  stubFetch(() => new TypeError("fetch failed"));
  const r = await post({ url: "https://youtu.be/abc" });
  expect(r.status).toBe(503);
  expect(await r.json()).toHaveProperty("detail");
});
