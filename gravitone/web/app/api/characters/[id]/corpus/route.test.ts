// The corpus proxies: the read of what audio a box kept, and the deletion of
// one recording.
//
// What these pin is passthrough — status, body and Retry-After — because every
// interesting answer on this surface is a NAMED one the panel renders verbatim:
// an empty corpus (200 with `totals.clips = 0`, NOT a 404), a 404 for a clip
// hash that is not there, a 400 for a bad character id, and a deletion REPORT
// the user is shown instead of a bare 204.
//
// Same harness as app/api/keys/route.test.ts: the real handlers, `fetch`
// stubbed at the backend boundary.

import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";
import { DELETE } from "./[sha]/route";

type Call = { url: string; init: RequestInit };

function stubFetch(reply: (url: string) => Response | Error) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const r = reply(url);
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

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const clipParams = (id: string, sha: string) => ({ params: Promise.resolve({ id, sha }) });

const req = (url: string, method = "GET") =>
  new Request(url, { method }) as unknown as import("next/server").NextRequest;

afterEach(() => { vi.unstubAllGlobals(); });

describe("GET /api/characters/{id}/corpus", () => {
  it("asks the service for that character's corpus, url-encoded", async () => {
    const calls = stubFetch(() => json({ totals: { clips: 0 } }));
    await GET(req("http://studio.local/api/characters/a%20b/corpus"), params("a b"));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/v1\/characters\/a%20b\/corpus$/);
  });

  it("relays an EMPTY corpus as a 200 — 'nothing is kept' is an answer", async () => {
    // The one thing this route must never do is turn the empty view into a
    // failure: a legacy character with no corpus is not an error state.
    stubFetch(() => json({
      character_id: "sarah", clips: [],
      totals: { clips: 0, segments: 0, seconds: 0, bytes: 0 },
    }));
    const r = await GET(req("http://studio.local/x"), params("sarah"));
    expect(r.status).toBe(200);
    expect((await r.json()).totals.clips).toBe(0);
  });

  it("keeps a refusal's status AND its detail", async () => {
    stubFetch(() => json({ detail: "character_id is not a valid character id" }, 400));
    const r = await GET(req("http://studio.local/x"), params("../etc"));
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/not a valid character id/);
  });

  it("answers an unreachable backend with the one 503 shape", async () => {
    stubFetch(() => new Error("ECONNREFUSED"));
    const r = await GET(req("http://studio.local/x"), params("sarah"));
    expect(r.status).toBe(503);
    expect((await r.json()).detail).toBe("backend unreachable");
  });
});

describe("DELETE /api/characters/{id}/corpus/{sha}", () => {
  it("deletes by clip hash and hands the REPORT back verbatim", async () => {
    // Deliberately not a 204: the report is the evidence the user is shown.
    const report = {
      removed: { clip_sha256: "abc", segments: 12, seconds: 41.5, bytes: 900,
                 files_deleted: true },
      reason: null, corpus_rev: 4, remaining: { clips: 1, bytes: 500 },
    };
    const calls = stubFetch(() => json(report));
    const r = await DELETE(req("http://studio.local/x", "DELETE"), clipParams("sarah", "abc"));
    expect(calls[0].url).toMatch(/\/v1\/characters\/sarah\/corpus\/abc$/);
    expect(calls[0].init.method).toBe("DELETE");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(report);
  });

  it("relays the service's 404 for a clip hash it does not hold", async () => {
    stubFetch(() => json({ detail: "no recording with that clip hash is in this character's corpus" }, 404));
    const r = await DELETE(req("http://studio.local/x", "DELETE"), clipParams("sarah", "nope"));
    expect(r.status).toBe(404);
    expect((await r.json()).detail).toMatch(/no recording with that clip hash/);
  });

  it("preserves Retry-After so backpressure survives the proxy", async () => {
    stubFetch(() => json({ detail: "too many recordings" }, 429, { "Retry-After": "7" }));
    const r = await DELETE(req("http://studio.local/x", "DELETE"), clipParams("sarah", "abc"));
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("7");
  });
});
