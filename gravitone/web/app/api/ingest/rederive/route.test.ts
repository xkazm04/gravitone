// The rederive kickoff proxy.
//
// Its whole value is that the service answers its refusals synchronously and by
// name — 404 "there is no corpus for this character", 409 over-cap / nothing
// matched, 429 with a Retry-After — so the studio can say what to do next
// instead of starting a job that dies a minute later. A proxy that collapsed
// those into a generic 502 would destroy exactly that.

import { afterEach, describe, expect, it, vi } from "vitest";

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
  POST(new Request("http://studio.local/api/ingest/rederive", {
    method: "POST", body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest);

afterEach(() => { vi.unstubAllGlobals(); });

it("relays the body to /v1/ingest/rederive and returns the job", async () => {
  const calls = stubFetch(() => json({ job_id: "j1", mode: "rederive",
    selection: { neutral: 3 }, corpus_rev: 2 }));
  const r = await post({ character_id: "sarah" });
  expect(calls[0].url).toMatch(/\/v1\/ingest\/rederive$/);
  expect(calls[0].init.method).toBe("POST");
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ character_id: "sarah" });
  expect((await r.json()).job_id).toBe("j1");
});

it("keeps the 404 that means 'nothing was ever kept for this character'", async () => {
  stubFetch(() => json({ detail: "there is no corpus for this character — capture is opt-in" }, 404));
  const r = await post({ character_id: "legacy" });
  expect(r.status).toBe(404);
  expect((await r.json()).detail).toMatch(/no corpus for this character/);
});

it("keeps the 409 that names an over-cap corpus", async () => {
  stubFetch(() => json({ detail: "this character's corpus is 900 bytes, over its 500-byte cap" }, 409));
  const r = await post({ character_id: "sarah" });
  expect(r.status).toBe(409);
  expect((await r.json()).detail).toMatch(/over its 500-byte cap/);
});

it("preserves Retry-After from the admission gate", async () => {
  stubFetch(() => json({ detail: "too many recordings are being processed" }, 429,
    { "Retry-After": "12" }));
  const r = await post({ character_id: "sarah" });
  expect(r.status).toBe(429);
  expect(r.headers.get("Retry-After")).toBe("12");
});

it("answers an unreachable backend with the one 503 shape", async () => {
  stubFetch(() => new Error("ECONNREFUSED"));
  const r = await post({ character_id: "sarah" });
  expect(r.status).toBe(503);
  expect((await r.json()).detail).toBe("backend unreachable");
});

it("refuses an oversize body before it reaches the backend", async () => {
  const calls = stubFetch(() => json({}));
  const r = await POST(new Request("http://studio.local/api/ingest/rederive", {
    method: "POST", body: JSON.stringify({ character_id: "s", emotions: ["x".repeat(9000)] }),
  }) as unknown as import("next/server").NextRequest);
  expect(r.status).toBe(413);
  expect(calls).toHaveLength(0);
});
