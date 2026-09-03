// The ingest ASSET proxy, exercised through the segment route.
//
// Its refusals are the whole point. The service distinguishes four reasons a
// segment has no audio (`ingest_api.py::_segment_refusal`) and a fifth answer
// that means the session itself is gone — and this proxy used to flatten all
// five to `{"detail":"not found"}`, which is the one thing the board cannot
// work with. Written against the segment route because it is the one with the
// most to lose; the stem/speaker previews share the same helper.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { GET } from "./route";

function stubFetch(reply: () => Response | Error) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const r = reply();
    if (r instanceof Error) throw r;
    return r;
  }));
  return calls;
}

const get = (job = "j1", index = "4") =>
  GET({} as NextRequest, { params: Promise.resolve({ job, index }) });

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...headers },
  });

afterEach(() => { vi.unstubAllGlobals(); });

describe("GET /api/ingest/[job]/segment/[index]", () => {
  it("streams the wav and caches it — a segment file never changes", async () => {
    const calls = stubFetch(() => new Response("RIFF", { status: 200 }));
    const r = await get();
    expect(calls[0]).toMatch(/\/v1\/ingest\/j1\/segment\/4$/);
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("audio/wav");
    expect(r.headers.get("Cache-Control")).toMatch(/immutable/);
  });

  it("percent-encodes the path segments it is handed", async () => {
    const calls = stubFetch(() => new Response("RIFF", { status: 200 }));
    await get("a/b", "1");
    expect(calls[0]).toMatch(/\/v1\/ingest\/a%2Fb\/segment\/1$/);
  });

  it("keeps the sentence that says WHY a segment has no audio", async () => {
    stubFetch(() => json(
      { detail: "segment 4 was measured as not the target speaker, so it is not available to any stem" },
      404));
    const r = await get();
    expect(r.status).toBe(404);
    expect((await r.json()).detail).toMatch(/measured as not the target speaker/);
  });

  it("keeps the decode failure apart from it", async () => {
    stubFetch(() => json(
      { detail: "segment 4 has no audio - that span of the recording could not be decoded" }, 404));
    expect((await (await get()).json()).detail).toMatch(/could not be decoded/);
  });

  it("keeps the expired-session answer, status field included", async () => {
    stubFetch(() => json({ status: "expired", detail: "job not found or expired" }, 404));
    const r = await get();
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ status: "expired", detail: "job not found or expired" });
  });

  it("preserves Retry-After on a refusal, like every other proxy", async () => {
    stubFetch(() => json({ detail: "busy" }, 429, { "Retry-After": "7" }));
    const r = await get();
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("7");
  });

  it("still answers JSON when the upstream refusal carried no body", async () => {
    stubFetch(() => new Response("", { status: 404 }));
    const r = await get();
    expect(r.status).toBe(404);
    expect((await r.json()).detail).toBe("not found");
  });

  it("answers an unreachable backend with the one 503 shape", async () => {
    stubFetch(() => new Error("ECONNREFUSED"));
    const r = await get();
    expect(r.status).toBe(503);
    expect((await r.json()).detail).toBe("backend unreachable");
  });
});
