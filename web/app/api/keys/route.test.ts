// The key-management proxies had no tests at all, while the backend's own
// test_keys.py covers revoke-while-listed, unrotatable-after-revoke and the
// cross-process locking. Everything those behaviours are worth depends on the
// studio sending the RIGHT request to the RIGHT path, which lived only in
// comments.
//
// Same shape as app/api/speak/route.test.ts: drive the real handlers with
// `fetch` stubbed at the backend boundary, so what is asserted is the request
// the service would actually receive and the response a browser would get.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { GET as listGET, POST as createPOST } from "./route";
import { DELETE as destroyDELETE, POST as rotatePOST } from "./[id]/route";
import { POST as revokePOST } from "./[id]/revoke/route";

afterEach(() => { vi.unstubAllGlobals(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(res: Response | Error) {
  const fn = vi.fn((..._args: unknown[]) =>
    res instanceof Error ? Promise.reject(res) : Promise.resolve(res));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The (url, init) the handler passed to the backend. */
function calledWith(fn: ReturnType<typeof stubFetch>): { url: string; init: RequestInit } {
  const [url, init] = fn.mock.calls[0] as [string, RequestInit];
  return { url, init };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method = "POST") =>
  new Request("http://studio.local/api/keys/k_1", { method }) as unknown as NextRequest;

describe("/api/keys — list & create", () => {
  it("lists keys from /v1/keys, passing the body through untouched", async () => {
    const row = { id: "k_1", name: "Mobile", prefix: "gk_abc", scopes: ["tts"], created: "2026-01-01T00:00:00Z", last_used: null, revoked: false };
    stubFetch(json([row]));
    const res = await listGET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([row]);
  });

  it("creates through POST /v1/keys with the caller's body", async () => {
    const f = stubFetch(json({ id: "k_2", secret: "gk_live_secret" }, 200));
    const res = await createPOST(new Request("http://studio.local/api/keys", {
      method: "POST", body: JSON.stringify({ name: "CI", scopes: ["tts", "clone"] }),
    }));
    expect(res.status).toBe(200);
    const { url, init } = calledWith(f);
    expect(url).toMatch(/\/v1\/keys$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ name: "CI", scopes: ["tts", "clone"] });
  });

  it("keeps the backend's status and detail on a rejected create", async () => {
    // Not a generic 502: the ledger shows this detail verbatim.
    stubFetch(json({ detail: "scope 'admin' is not grantable" }, 400));
    const res = await createPOST(new Request("http://studio.local/api/keys", {
      method: "POST", body: JSON.stringify({ name: "x", scopes: ["admin"] }),
    }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ detail: "scope 'admin' is not grantable" });
  });

  it("answers a JSON 503 when the backend cannot be reached", async () => {
    stubFetch(new Error("ECONNREFUSED"));
    const res = await listGET();
    expect(res.status).toBe(503);
    // JSON, because an ElevenLabs drop-in client parses every body as JSON.
    await expect(res.json()).resolves.toHaveProperty("detail");
  });
});

describe("/api/keys/[id]/revoke — the non-destructive kill", () => {
  it("POSTs the backend's revoke path, and never DELETEs", async () => {
    // The distinction this route exists for: revoke must not destroy the key's
    // audit identity, so it must not reach DELETE /v1/keys/{id}.
    const f = stubFetch(json({ id: "k_1", revoked: true }));
    const res = await revokePOST(req(), ctx("k_1"));
    expect(res.status).toBe(200);
    const { url, init } = calledWith(f);
    expect(url).toMatch(/\/v1\/keys\/k_1\/revoke$/);
    expect(init.method).toBe("POST");
  });

  it("url-encodes the id rather than splicing it into the path", async () => {
    const f = stubFetch(json({}));
    await revokePOST(req(), ctx("k/../admin"));
    expect(calledWith(f).url).toContain("k%2F..%2Fadmin/revoke");
  });

  it("passes a 404 for an unknown key through with its detail", async () => {
    stubFetch(json({ detail: "no such key" }, 404));
    const res = await revokePOST(req(), ctx("nope"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ detail: "no such key" });
  });
});

describe("/api/keys/[id] — rotate & destroy", () => {
  it("rotates via /v1/keys/{id}/rotate", async () => {
    const f = stubFetch(json({ id: "k_1", secret: "gk_rotated" }));
    await rotatePOST(req(), ctx("k_1"));
    const { url, init } = calledWith(f);
    expect(url).toMatch(/\/v1\/keys\/k_1\/rotate$/);
    expect(init.method).toBe("POST");
  });

  it("surfaces the backend's 409 for rotating a revoked key", async () => {
    // Reachable only because the ledger keeps rotate clickable on a revoked
    // row; if the proxy swallowed the detail, the user would see nothing.
    stubFetch(json({ detail: "cannot rotate a revoked key" }, 409));
    const res = await rotatePOST(req(), ctx("k_1"));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ detail: "cannot rotate a revoked key" });
  });

  it("destroys via DELETE /v1/keys/{id} — no /revoke segment", async () => {
    const f = stubFetch(new Response(null, { status: 204 }));
    const res = await destroyDELETE(req("DELETE"), ctx("k_1"));
    expect(res.status).toBe(204);
    const { url, init } = calledWith(f);
    expect(url).toMatch(/\/v1\/keys\/k_1$/);
    expect(url).not.toContain("revoke");
    expect(init.method).toBe("DELETE");
  });

  it("keeps the detail of a refused destroy instead of an empty body", async () => {
    stubFetch(json({ detail: "key not found" }, 404));
    const res = await destroyDELETE(req("DELETE"), ctx("gone"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ detail: "key not found" });
  });
});
