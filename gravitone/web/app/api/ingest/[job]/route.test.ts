// The poller's own endpoint.
//
// It is hit every 1.5-5s for the length of a scan and every 30s for as long as
// a ledger is on screen, and it answers with the job's WHOLE result each time.
// The ETag is what stops that; these pin that the validator is content-derived
// (so it survives the N-replica deployment, which has no shared counter) and
// that it is never attached to something that is not the job.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { GET, DELETE } from "./route";

function stubFetch(reply: () => Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init: init ?? {},
    });
    const r = reply();
    if (r instanceof Error) throw r;
    return r;
  }));
  return calls;
}

const req = (headers: Record<string, string> = {}) =>
  new Request("http://studio.local/api/ingest/j1", { headers }) as unknown as NextRequest;

const get = (headers: Record<string, string> = {}, job = "j1") =>
  GET(req(headers), { params: Promise.resolve({ job }) });

const JOB = { status: "running", step: "isolate", steps: [], partial: {}, result: null };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...headers },
  });

afterEach(() => { vi.unstubAllGlobals(); });

describe("GET /api/ingest/[job]", () => {
  it("returns the job with a strong ETag", async () => {
    stubFetch(() => json(JOB));
    const r = await get();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(JOB);
    const etag = r.headers.get("ETag")!;
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);   // strong: no W/ prefix
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers 304 with no body when the job has not changed", async () => {
    stubFetch(() => json(JOB));
    const etag = (await get()).headers.get("ETag")!;
    const again = await get({ "If-None-Match": etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("ETag")).toBe(etag);
  });

  it("ships the payload again the moment anything in it moves", async () => {
    stubFetch(() => json(JOB));
    const etag = (await get()).headers.get("ETag")!;
    vi.unstubAllGlobals();
    stubFetch(() => json({ ...JOB, step: "classify" }));
    const moved = await get({ "If-None-Match": etag });
    expect(moved.status).toBe(200);
    expect((await moved.json()).step).toBe("classify");
    expect(moved.headers.get("ETag")).not.toBe(etag);
  });

  it("derives the tag from the bytes, so any replica computes the same one", async () => {
    stubFetch(() => json(JOB));
    const a = (await get()).headers.get("ETag");
    vi.unstubAllGlobals();
    stubFetch(() => json(JOB));
    expect((await get()).headers.get("ETag")).toBe(a);
  });

  it("never tags a refusal — an expired job must not validate as the job", async () => {
    stubFetch(() => json({ status: "expired", detail: "job not found or expired" }, 404));
    const r = await get({ "If-None-Match": '"anything"' });
    expect(r.status).toBe(404);
    expect(r.headers.get("ETag")).toBeNull();
    expect((await r.json()).detail).toMatch(/expired/);
  });

  it("passes an unreachable backend straight through", async () => {
    stubFetch(() => new Error("ECONNREFUSED"));
    const r = await get();
    expect(r.status).toBe(503);
    expect(r.headers.get("ETag")).toBeNull();
    expect((await r.json()).detail).toBe("backend unreachable");
  });

  it("encodes the job id into the upstream path", async () => {
    const calls = stubFetch(() => json(JOB));
    await get({}, "a/b");
    expect(calls[0].url).toMatch(/\/v1\/ingest\/a%2Fb$/);
  });
});

describe("DELETE /api/ingest/[job]", () => {
  it("relays the teardown and keeps the upstream status", async () => {
    const calls = stubFetch(() => json({ detail: "this job is committing" }, 409));
    const r = await DELETE(req(), { params: Promise.resolve({ job: "j1" }) });
    expect(calls[0].init.method).toBe("DELETE");
    expect(r.status).toBe(409);
    expect((await r.json()).detail).toBe("this job is committing");
  });
});
