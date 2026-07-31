// The two convai proxies. Same shape as app/api/keys/route.test.ts: drive the
// real handlers with `fetch` stubbed at the backend boundary, so what is
// asserted is the request the service would receive and the response a browser
// would get.
//
// What is worth pinning: the API key never reaches the browser (the ticket in
// `signed_url` is what the socket authenticates with), a missing agent_id is
// refused HERE with a sentence rather than forwarded into a 422 validation dump,
// and the upstream status survives — `enabled: false` is a 200 with a body,
// while 401/503 must not read as "no agents installed".

import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as agentsGET } from "../agents/route";
import { GET as signedGET } from "./route";

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

const calledUrl = (fn: ReturnType<typeof stubFetch>) => String((fn.mock.calls[0] as [string])[0]);

describe("/api/convai/agents", () => {
  it("passes the service's answer through untouched", async () => {
    const body = {
      agents: [{ agent_id: "interviewer", name: "Interviewer", speakable: true }],
      brain: { backend: "scripted" }, enabled: true, sessions: { active: 0, max: 2 },
    };
    const f = stubFetch(json(body));
    const res = await agentsGET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(body);
    expect(calledUrl(f)).toMatch(/\/v1\/convai\/agents$/);
  });

  it("keeps a keyed backend's 401 instead of reporting an empty roster", async () => {
    stubFetch(json({ detail: "invalid api key" }, 401));
    const res = await agentsGET();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ detail: "invalid api key" });
  });

  it("answers a JSON 503 when the service cannot be reached", async () => {
    stubFetch(new Error("ECONNREFUSED"));
    const res = await agentsGET();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toHaveProperty("detail");
  });
});

describe("/api/convai/signed-url", () => {
  const req = (qs: string) =>
    new Request(`http://studio.local/api/convai/signed-url${qs}`);

  it("mints a ticketed url for the requested agent", async () => {
    const f = stubFetch(json({ signed_url: "ws://127.0.0.1:8080/v1/convai/conversation?agent_id=a&token=t", expires_in_s: 300 }));
    const res = await signedGET(req("?agent_id=interviewer"));
    expect(res.status).toBe(200);
    // The socket URL names the SERVICE origin — the browser dials it directly.
    await expect(res.json()).resolves.toMatchObject({ signed_url: expect.stringContaining("token=") });
    expect(calledUrl(f)).toContain("/v1/convai/conversation/get-signed-url?agent_id=interviewer");
  });

  it("url-encodes the agent id rather than splicing it into the query", async () => {
    const f = stubFetch(json({ signed_url: "ws://x" }));
    await signedGET(req("?agent_id=a%20b%26admin=1"));
    expect(calledUrl(f)).toContain("agent_id=a%20b%26admin%3D1");
  });

  it("refuses a missing agent_id with a sentence, and never calls the service", async () => {
    const f = stubFetch(json({}));
    const res = await signedGET(req(""));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ detail: "agent_id is required to open a conversation" });
    expect(f).not.toHaveBeenCalled();
  });

  it("passes the service's 503 for a disabled conversational surface through", async () => {
    // CONVAI_ENABLED=0 — the Live stage says exactly this, in these words.
    stubFetch(json({ detail: "conversational agents are disabled on this service (CONVAI_ENABLED=0)" }, 503));
    const res = await signedGET(req("?agent_id=interviewer"));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ detail: expect.stringContaining("CONVAI_ENABLED=0") });
  });

  it("passes a 404 for an unknown agent through with its available-agents detail", async () => {
    stubFetch(json({ detail: "unknown agent 'nope'. Available: interviewer" }, 404));
    const res = await signedGET(req("?agent_id=nope"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ detail: expect.stringContaining("Available: interviewer") });
  });
});
