// The link-scan kickoff proxy.
//
// Same value as the rederive proxy: the service answers this route's refusals
// synchronously and BY NAME — 403 "that is not a YouTube link", 413 over the
// byte ceiling, 422 "that video is private", 429 with a Retry-After, 503 "no
// extractor here" — and each `detail` already names the file-drop fallback. A
// proxy that flattened them into a generic 502 would turn every one of those
// into "something went wrong", which on the brittlest path in the product is
// exactly the wrong trade.

import { afterEach, expect, it, vi } from "vitest";

import { POST } from "./route";

type Call = { url: string; init: RequestInit };

function stubFetch(reply: () => Response | Error) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const r = reply();
    if (r instanceof Error) throw r;
    return r;
  });
  vi.stubGlobal("fetch", f);
  return calls;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...headers },
  });

const post = (body: unknown) =>
  POST(new Request("http://studio.local/api/ingest/scan-url", {
    method: "POST", body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest);

afterEach(() => { vi.unstubAllGlobals(); });

it("relays the link to /v1/ingest/scan-url and returns the job", async () => {
  const calls = stubFetch(() => json({
    job_id: "j1", mode: "sovereign",
    source: { kind: "url", url: "https://youtu.be/abc" },
  }));
  const r = await post({ url: "https://youtu.be/abc", mode: "sovereign" });
  expect(calls[0].url).toMatch(/\/v1\/ingest\/scan-url$/);
  expect(calls[0].init.method).toBe("POST");
  expect(JSON.parse(String(calls[0].init.body))).toEqual({
    url: "https://youtu.be/abc", mode: "sovereign",
  });
  expect(r.status).toBe(200);
  expect((await r.json()).source.kind).toBe("url");
});

it.each([
  [403, "'evil.example' is not a YouTube link — download the audio and drop the file instead."],
  [413, "that video's audio is over the 50 MB ceiling this box will fetch."],
  [422, "that video is private. Download the audio and drop the file instead."],
  [503, "this deployment cannot fetch links right now (the extractor is missing)."],
])("passes a %i refusal through with its own sentence", async (status, detail) => {
  stubFetch(() => json({ detail }, status));
  const r = await post({ url: "https://youtu.be/abc" });
  expect(r.status).toBe(status);
  expect((await r.json()).detail).toBe(detail);
});

it("keeps Retry-After on a 429 so the studio can count down", async () => {
  stubFetch(() => json({ detail: "rate-limited" }, 429, { "Retry-After": "42" }));
  const r = await post({ url: "https://youtu.be/abc" });
  expect(r.status).toBe(429);
  expect(r.headers.get("Retry-After")).toBe("42");
});

it("refuses an absurd body without calling the backend", async () => {
  const calls = stubFetch(() => json({}));
  const r = await post({ url: "x".repeat(9000) });
  expect(r.status).toBe(413);
  expect(calls).toHaveLength(0);
});

it("reports an unreachable backend rather than an empty job", async () => {
  stubFetch(() => new TypeError("fetch failed"));
  const r = await post({ url: "https://youtu.be/abc" });
  expect(r.status).toBe(503);
  expect(await r.json()).toHaveProperty("detail");
});
