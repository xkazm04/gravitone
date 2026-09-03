// The key-management proxies had no tests at all, while the backend's own
// test_keys.py covers revoke-while-listed, unrotatable-after-revoke and the
// cross-process locking. Everything those behaviours are worth depends on the
// studio sending the RIGHT request to the RIGHT path, which lived only in
// comments.
//
// Same shape as app/api/speak/route.test.ts: drive the real handlers with
// `fetch` stubbed at the backend boundary, so what is asserted is the request
// the service would actually receive and the response a browser would get.
//
// The second half of this file is the AUTHORIZATION contract added after these
// routes were found to be an open key-minting endpoint: they proxied with the
// backend's root key and asked nothing of the caller. Those tests are the ones
// that fail if the door is ever propped open again — see ./identity.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { GET as listGET, POST as createPOST } from "./route";
import { DELETE as destroyDELETE, POST as rotatePOST } from "./[id]/route";
import { POST as revokePOST } from "./[id]/revoke/route";
import { GET as manifestGET } from "./[id]/manifest/route";

const { verifyIdToken } = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock("@/lib/idToken", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/idToken")>()),
  verifyIdToken,
}));

const PROJECT = "NEXT_PUBLIC_FIREBASE_PROJECT_ID";
const savedProject = process.env[PROJECT];

beforeEach(() => {
  // Single-user (no Firebase configured) unless a test says otherwise: that is
  // the `git clone && npm run dev` deployment.
  delete process.env[PROJECT];
  delete process.env.FIREBASE_PROJECT_ID;
  verifyIdToken.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (savedProject === undefined) delete process.env[PROJECT];
  else process.env[PROJECT] = savedProject;
});

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

/** A backend that answers the ledger read with `ledger` and everything else
 *  with `then`. Every mutating route now reads the ledger first (to decide
 *  ownership), so a one-response stub no longer describes reality. */
function stubBackend(ledger: unknown[], then: Response | Error = json({})) {
  const fn = vi.fn((url: unknown, init?: RequestInit) => {
    const path = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && /\/v1\/keys$/.test(path)) return Promise.resolve(json(ledger));
    return then instanceof Error ? Promise.reject(then) : Promise.resolve(then.clone());
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The (url, init) of the LAST backend call — the one under test, after the
 *  ownership read. */
function lastCall(fn: ReturnType<typeof stubBackend>): { url: string; init: RequestInit } {
  const [url, init] = fn.mock.calls[fn.mock.calls.length - 1] as [string, RequestInit];
  return { url, init };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method = "POST", headers: HeadersInit = {}) =>
  new Request("http://studio.local/api/keys/k_1", { method, headers }) as unknown as NextRequest;

/** A ledger row as the SERVICE stores it. `owner` becomes the name tag. */
const row = (id: string, owner: string | null, name = "Mobile") => ({
  id,
  name: owner === null ? name : `u:${owner}|${name}`,
  prefix: "gk_abc",
  scopes: ["tts"],
  created: "2026-01-01T00:00:00Z",
  last_used: null,
  revoked: false,
});

describe("/api/keys — list & create", () => {
  it("lists keys from /v1/keys, passing the row through untouched", async () => {
    stubBackend([row("k_1", null)]);
    const res = await listGET(new Request("http://studio.local/api/keys"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([row("k_1", null)]);
  });

  it("creates through POST /v1/keys with the caller's name and scopes", async () => {
    const f = stubBackend([], json({ id: "k_2", name: "u:local|CI", secret: "gk_live_secret" }));
    const res = await createPOST(new Request("http://studio.local/api/keys", {
      method: "POST", body: JSON.stringify({ name: "CI", scopes: ["tts", "clone"] }),
    }));
    expect(res.status).toBe(200);
    const { url, init } = lastCall(f);
    expect(url).toMatch(/\/v1\/keys$/);
    expect(init.method).toBe("POST");
    const sent = JSON.parse(String(init.body));
    expect(sent.scopes).toEqual(["tts", "clone"]);
    // Tagged with the owner on the way out, untagged on the way back: the tag
    // is bookkeeping and never something the user typed or should read.
    expect(sent.name).toBe("u:local|CI");
    await expect(res.json()).resolves.toMatchObject({ name: "CI", secret: "gk_live_secret" });
  });

  it("refuses a scope the service would never grant a managed key", async () => {
    const f = stubBackend([]);
    const res = await createPOST(new Request("http://studio.local/api/keys", {
      method: "POST", body: JSON.stringify({ name: "x", scopes: ["admin"] }),
    }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      detail: "scope 'admin' is not grantable to a managed key",
    });
    // and never reached the backend with the root key attached
    expect(f).not.toHaveBeenCalled();
  });

  it("keeps the backend's status and detail on a rejected create", async () => {
    // Not a generic 502: the ledger shows this detail verbatim.
    stubBackend([], json({ detail: "scope 'tts' is unknown to this build" }, 400));
    const res = await createPOST(new Request("http://studio.local/api/keys", {
      method: "POST", body: JSON.stringify({ name: "x", scopes: ["tts"] }),
    }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ detail: "scope 'tts' is unknown to this build" });
  });

  it("answers a JSON 503 when the backend cannot be reached", async () => {
    stubFetch(new Error("ECONNREFUSED"));
    const res = await listGET(new Request("http://studio.local/api/keys"));
    expect(res.status).toBe(503);
    // JSON, because an ElevenLabs drop-in client parses every body as JSON.
    await expect(res.json()).resolves.toHaveProperty("detail");
  });
});

describe("/api/keys/[id]/revoke — the non-destructive kill", () => {
  it("POSTs the backend's revoke path, and never DELETEs", async () => {
    // The distinction this route exists for: revoke must not destroy the key's
    // audit identity, so it must not reach DELETE /v1/keys/{id}.
    const f = stubBackend([row("k_1", null)], json({ id: "k_1", revoked: true }));
    const res = await revokePOST(req(), ctx("k_1"));
    expect(res.status).toBe(200);
    const { url, init } = lastCall(f);
    expect(url).toMatch(/\/v1\/keys\/k_1\/revoke$/);
    expect(init.method).toBe("POST");
  });

  it("url-encodes the id rather than splicing it into the path", async () => {
    const f = stubBackend([row("k/../admin", null)], json({}));
    await revokePOST(req(), ctx("k/../admin"));
    expect(lastCall(f).url).toContain("k%2F..%2Fadmin/revoke");
  });

  it("answers 404 for a key the ledger does not hold", async () => {
    stubBackend([]);
    const res = await revokePOST(req(), ctx("nope"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ detail: "no such key" });
  });
});

describe("/api/keys/[id] — rotate & destroy", () => {
  it("rotates via /v1/keys/{id}/rotate", async () => {
    const f = stubBackend(
      [row("k_1", null)],
      json({ id: "k_1", name: "u:local|Mobile", secret: "gk_rotated" }),
    );
    const res = await rotatePOST(req(), ctx("k_1"));
    const { url, init } = lastCall(f);
    expect(url).toMatch(/\/v1\/keys\/k_1\/rotate$/);
    expect(init.method).toBe("POST");
    await expect(res.json()).resolves.toMatchObject({ name: "Mobile", secret: "gk_rotated" });
  });

  it("surfaces the backend's 409 for rotating a revoked key", async () => {
    // Reachable only because the ledger keeps rotate clickable on a revoked
    // row; if the proxy swallowed the detail, the user would see nothing.
    stubBackend([row("k_1", null)], json({ detail: "cannot rotate a revoked key" }, 409));
    const res = await rotatePOST(req(), ctx("k_1"));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ detail: "cannot rotate a revoked key" });
  });

  it("destroys via DELETE /v1/keys/{id} — no /revoke segment", async () => {
    const f = stubBackend([row("k_1", null)], new Response(null, { status: 204 }));
    const res = await destroyDELETE(req("DELETE"), ctx("k_1"));
    expect(res.status).toBe(204);
    const { url, init } = lastCall(f);
    expect(url).toMatch(/\/v1\/keys\/k_1$/);
    expect(url).not.toContain("revoke");
    expect(init.method).toBe("DELETE");
  });

  it("keeps the detail of a refused destroy instead of an empty body", async () => {
    stubBackend([row("gone", null)], json({ detail: "key not found" }, 404));
    const res = await destroyDELETE(req("DELETE"), ctx("gone"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ detail: "key not found" });
  });
});

// ── the vulnerability these routes shipped with ──────────────────────────────
//
// Before this, /api/keys was twelve lines of passthrough carrying the backend's
// ROOT key (which service/auth.py accepts for every scope, `admin` included).
// An anonymous POST minted a live credential; a GET enumerated everyone's; a
// POST to {id}/revoke killed anyone's. Each test below is one of those calls.

describe("anonymous access, with Firebase configured", () => {
  beforeEach(() => { process.env[PROJECT] = "gravitone-prod"; });

  it("cannot mint a key — 401 with a challenge, and the backend is never called", async () => {
    const f = stubBackend([]);
    const res = await createPOST(new Request("http://studio.local/api/keys", {
      method: "POST", body: JSON.stringify({ name: "pwned", scopes: ["tts", "clone"] }),
    }));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    await expect(res.json()).resolves.toHaveProperty("detail");
    // The point: the root key never left the process on this request.
    expect(f).not.toHaveBeenCalled();
  });

  it("cannot enumerate the ledger", async () => {
    const f = stubBackend([row("k_1", "alice"), row("k_2", "bob")]);
    const res = await listGET(new Request("http://studio.local/api/keys"));
    expect(res.status).toBe(401);
    expect(f).not.toHaveBeenCalled();
  });

  it("cannot revoke, rotate, destroy, or read a manifest", async () => {
    const f = stubBackend([row("k_1", "alice")]);
    for (const call of [
      revokePOST(req(), ctx("k_1")),
      rotatePOST(req(), ctx("k_1")),
      destroyDELETE(req("DELETE"), ctx("k_1")),
      manifestGET(req("GET"), ctx("k_1")),
    ]) {
      expect((await call).status).toBe(401);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("cannot pass a forged or expired token off as an identity", async () => {
    verifyIdToken.mockResolvedValue(null);
    const f = stubBackend([]);
    const res = await listGET(new Request("http://studio.local/api/keys", {
      headers: { authorization: "Bearer not.a.real.token" },
    }));
    expect(res.status).toBe(401);
    expect(f).not.toHaveBeenCalled();
  });

  it("cannot use a Gravitone API key as an identity — that is the surface, not the credential", async () => {
    verifyIdToken.mockResolvedValue(null);
    const res = await listGET(new Request("http://studio.local/api/keys", {
      headers: { "xi-api-key": "gk_live_whatever" },
    }));
    expect(res.status).toBe(401);
  });
});

describe("a signed-in user, with Firebase configured", () => {
  const alice = { authorization: "Bearer alice.token" };
  beforeEach(() => {
    process.env[PROJECT] = "gravitone-prod";
    verifyIdToken.mockImplementation(async (t: string) =>
      (t === "alice.token" ? { uid: "alice", email: "a@example.com" } : null));
  });

  it("sees only their own keys — not bob's, and not the untagged legacy ones", async () => {
    stubBackend([row("k_1", "alice", "Mine"), row("k_2", "bob", "Theirs"), row("k_3", null, "Ancient")]);
    const res = await listGET(new Request("http://studio.local/api/keys", { headers: alice }));
    expect(res.status).toBe(200);
    const list = (await res.json()) as { id: string; name: string }[];
    expect(list.map((k) => k.id)).toEqual(["k_1"]);
    expect(list[0].name).toBe("Mine"); // the tag never leaves the server
  });

  it("cannot revoke bob's key — refused as 404, so the ledger cannot be probed by id", async () => {
    const f = stubBackend([row("k_2", "bob")], json({ id: "k_2", revoked: true }));
    const res = await revokePOST(req("POST", alice), ctx("k_2"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ detail: "no such key" });
    // The ledger read happened; the revoke did not.
    expect(f.mock.calls.every(([, init]) => (init as RequestInit)?.method !== "POST")).toBe(true);
  });

  it("cannot rotate or destroy bob's key either", async () => {
    stubBackend([row("k_2", "bob")], json({ secret: "gk_should_never_be_issued" }));
    expect((await rotatePOST(req("POST", alice), ctx("k_2"))).status).toBe(404);
    expect((await destroyDELETE(req("DELETE", alice), ctx("k_2"))).status).toBe(404);
  });

  it("cannot forge ownership through the key NAME", async () => {
    // A name crafted to look like someone else's tag is still just a name: the
    // tag this route writes comes from the verified token, and it is prepended.
    const f = stubBackend([], json({ id: "k_9", name: "x", secret: "s" }));
    await createPOST(new Request("http://studio.local/api/keys", {
      method: "POST", headers: alice, body: JSON.stringify({ name: "u:bob|stolen", scopes: ["tts"] }),
    }));
    expect(JSON.parse(String(lastCall(f).init.body)).name).toBe("u:alice|u:bob|stolen");
  });

  it("revokes their OWN key exactly as before", async () => {
    const f = stubBackend([row("k_1", "alice")], json({ id: "k_1", revoked: true }));
    const res = await revokePOST(req("POST", alice), ctx("k_1"));
    expect(res.status).toBe(200);
    expect(lastCall(f).url).toMatch(/\/v1\/keys\/k_1\/revoke$/);
  });
});

describe("single-user mode (no Firebase configured)", () => {
  it("works with no token at all, and says so in the response", async () => {
    stubBackend([row("k_1", null, "Ancient")]);
    const res = await listGET(new Request("http://studio.local/api/keys"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Gravitone-Auth-Mode")).toBe("single-user");
    // The untagged keys of an existing local install stay visible and usable.
    await expect(res.json()).resolves.toHaveLength(1);
  });
});
