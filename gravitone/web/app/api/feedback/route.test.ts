// The feedback route's whole job is to be un-spoofable and un-abusable, so the
// tests are about what it REFUSES: an empty message, a novel, a caller with no
// token, a caller with a token Google will not vouch for, and a deployment with
// no Firebase at all. The one acceptance test then proves that the uid written
// to Firestore is the one GOOGLE returned — never anything the client sent.
//
// Same harness as the other route tests here: the real handler, `fetch` stubbed
// at the network boundary.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_MESSAGE_CHARS } from "./limits";
import { POST } from "./route";

type Call = { url: string; init: RequestInit };

/** Stub both outbound hops. `lookup` decides what Identity Toolkit answers;
 *  `write` decides what Firestore answers. */
function stubFetch(opts: { lookup?: Response | Error; write?: Response | Error } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init: init ?? {} });
      const answer = url.includes("identitytoolkit") ? opts.lookup : opts.write;
      if (answer instanceof Error) throw answer;
      return answer ?? new Response("{}", { status: 200 });
    }),
  );
  return calls;
}

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const vouched = () => ok({ users: [{ localId: "uid-from-google", email: "real@example.com" }] });
const written = () =>
  ok({ name: "projects/p/databases/(default)/documents/feedback/doc-123" }, 200);

const post = (body: unknown) =>
  POST(
    new Request("http://studio.local/api/feedback", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "web-api-key");
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "gravitone-test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("input validation", () => {
  it("refuses an empty message before spending a network call", async () => {
    const calls = stubFetch();
    expect((await post({ idToken: "t", message: "   " })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("refuses a message past the cap", async () => {
    stubFetch();
    const r = await post({ idToken: "t", message: "x".repeat(MAX_MESSAGE_CHARS + 1) });
    expect(r.status).toBe(400);
  });

  it("accepts a message exactly at the cap", async () => {
    stubFetch({ lookup: vouched(), write: written() });
    expect((await post({ idToken: "t", message: "x".repeat(MAX_MESSAGE_CHARS) })).status).toBe(201);
  });

  it("refuses a body that is not JSON", async () => {
    stubFetch();
    expect((await post("not json at all")).status).toBe(400);
  });
});

describe("identity — never the client's word", () => {
  it("refuses a caller with no token", async () => {
    const calls = stubFetch();
    expect((await post({ message: "hi" })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("refuses a token Google will not vouch for", async () => {
    stubFetch({ lookup: ok({ error: { message: "INVALID_ID_TOKEN" } }, 400) });
    const r = await post({ idToken: "forged", message: "hi" });
    expect(r.status).toBe(401);
  });

  it("stores the uid GOOGLE returned, not one the client supplied", async () => {
    const calls = stubFetch({ lookup: vouched(), write: written() });
    const r = await post({ idToken: "t", message: "the pitch panel is confusing", route: "/voices", uid: "admin" });
    expect(r.status).toBe(201);

    const write = calls.find((c) => c.url.includes("firestore.googleapis.com"))!;
    const doc = JSON.parse(String(write.init.body)) as { fields: Record<string, { stringValue?: string }> };
    expect(doc.fields.uid.stringValue).toBe("uid-from-google");
    expect(doc.fields.uid.stringValue).not.toBe("admin");
    expect(doc.fields.message.stringValue).toBe("the pitch panel is confusing");
    expect(doc.fields.route.stringValue).toBe("/voices");
  });

  it("presents the user's own token to Firestore, so the deployed rules judge the write", async () => {
    const calls = stubFetch({ lookup: vouched(), write: written() });
    await post({ idToken: "user-token", message: "hi" });
    const write = calls.find((c) => c.url.includes("firestore.googleapis.com"))!;
    expect(new Headers(write.init.headers).get("Authorization")).toBe("Bearer user-token");
  });

  it("timestamps with the server clock", async () => {
    const calls = stubFetch({ lookup: vouched(), write: written() });
    await post({ idToken: "t", message: "hi", createdAt: "1999-01-01T00:00:00.000Z" });
    const write = calls.find((c) => c.url.includes("firestore.googleapis.com"))!;
    const doc = JSON.parse(String(write.init.body)) as { fields: { createdAt: { timestampValue: string } } };
    expect(doc.fields.createdAt.timestampValue).not.toContain("1999");
    expect(Date.parse(doc.fields.createdAt.timestampValue)).not.toBeNaN();
  });
});

describe("degraded deployments", () => {
  it("says so plainly when Firebase is not configured — and calls nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "");
    const calls = stubFetch();
    const r = await post({ idToken: "t", message: "hi" });
    expect(r.status).toBe(503);
    expect((await r.json()).detail).toMatch(/not configured/i);
    expect(calls).toHaveLength(0);
  });

  it("reports an unreachable Firestore as a 503, not a success", async () => {
    stubFetch({ lookup: vouched(), write: new Error("ECONNRESET") });
    expect((await post({ idToken: "t", message: "hi" })).status).toBe(503);
  });

  it("reads a rules refusal as a deployment fact, not the writer's fault", async () => {
    stubFetch({ lookup: vouched(), write: ok({ error: {} }, 403) });
    const r = await post({ idToken: "t", message: "hi" });
    expect(r.status).toBe(503);
    expect((await r.json()).detail).toMatch(/not accepting feedback/i);
  });
});
