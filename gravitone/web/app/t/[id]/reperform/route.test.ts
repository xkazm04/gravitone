// The share page's public compute relay — the one endpoint in this app whose
// entire audience is logged-out strangers, spending the CPU of the box that
// serves the page.
//
// Two boundaries meet here and neither is decorative:
//
//   * the TRUST boundary. The visitor's X-Forwarded-For is FORWARDED so the
//     service's per-IP budget can bill the right client — and it is never
//     trusted here. The service decides whether to honour it at all
//     (TTS_TRUST_PROXY) and which hop is the caller. A studio with no proxy in
//     front of it receives no such header and must forward none, or every
//     visitor would be billed to this process's own address.
//   * the REFUSAL boundary. Consent (allow_reperform), the text cap and the
//     rate limit all live in the service, and every refusal is named. The
//     panel shows those sentences verbatim, so this proxy must pass the status,
//     the detail and Retry-After through untouched — a collapsed 429 is a
//     visitor told "something went wrong" instead of "wait 12 seconds".

import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

type Call = { url: string; init: RequestInit };

function stubFetch(reply: () => Response | Error) {
  const calls: Call[] = [];
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

const post = (body: unknown, headers: Record<string, string> = {}, id = "t1") =>
  POST(new Request(`http://studio.local/t/${id}/reperform`, {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers,
  }), { params: Promise.resolve({ id }) });

/** The outbound header set, whatever shape the call site used. */
const sent = (call: Call) => new Headers(call.init.headers as HeadersInit);

afterEach(() => { vi.unstubAllGlobals(); });

describe("the relay itself", () => {
  it("posts the visitor's body to the service's reperform endpoint", async () => {
    const calls = stubFetch(() => json({ take_id: "child1" }));
    const r = await post({ text: "[calm] Try again." });

    expect(calls[0].url).toMatch(/\/v1\/takes\/t1\/reperform$/);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ text: "[calm] Try again." });
    expect(r.status).toBe(200);
    expect((await r.json()).take_id).toBe("child1");
  });

  it("relays a per-line cast body unchanged — the service refuses both forms at once", async () => {
    const calls = stubFetch(() => json({ take_id: "child2" }));
    await post({ lines: [{ character_id: "sarah", text: "hi" }] });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      lines: [{ character_id: "sarah", text: "hi" }],
    });
  });

  it("encodes the take id into the upstream path", async () => {
    const calls = stubFetch(() => json({ take_id: "c" }));
    await post({ text: "x" }, {}, "a/b");
    expect(calls[0].url).toContain("/v1/takes/a%2Fb/reperform");
  });
});

describe("the forwarded-for trust boundary", () => {
  it("forwards the visitor's address so the per-IP budget bills the visitor", async () => {
    const calls = stubFetch(() => json({ take_id: "c" }));
    await post({ text: "x" }, { "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    expect(sent(calls[0]).get("x-forwarded-for")).toBe("203.0.113.7, 10.0.0.1");
  });

  it("passes the chain VERBATIM — it does not pick a hop or rewrite it", async () => {
    // Which hop is the caller is TTS_TRUSTED_HOPS's decision, counted from the
    // right, because a client can forge the left. Trimming here would hand the
    // service a chain it cannot reason about.
    const calls = stubFetch(() => json({ take_id: "c" }));
    await post({ text: "x" }, { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" });
    expect(sent(calls[0]).get("x-forwarded-for")).toBe("1.1.1.1, 2.2.2.2, 3.3.3.3");
  });

  it("invents no address when the request carries none", async () => {
    const calls = stubFetch(() => json({ take_id: "c" }));
    await post({ text: "x" });
    expect(sent(calls[0]).has("x-forwarded-for")).toBe(false);
  });

  it("still sends the JSON content type the service parses", async () => {
    const calls = stubFetch(() => json({ take_id: "c" }));
    await post({ text: "x" }, { "x-forwarded-for": "203.0.113.7" });
    expect(sent(calls[0]).get("content-type")).toBe("application/json");
  });
});

describe("refusals reach the visitor as the service wrote them", () => {
  it("keeps the 403 that means the publisher never opted in", async () => {
    stubFetch(() => json({ detail: "this take was not published for re-performance" }, 403));
    const r = await post({ text: "x" });
    expect(r.status).toBe(403);
    expect((await r.json()).detail).toBe("this take was not published for re-performance");
  });

  it("keeps the 429 AND its Retry-After — the panel says how long to wait", async () => {
    stubFetch(() => json({ detail: "the shared re-perform budget is spent" }, 429,
      { "Retry-After": "12" }));
    const r = await post({ text: "x" });
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("12");
    expect((await r.json()).detail).toMatch(/budget is spent/);
  });

  it("keeps the named too-long refusal rather than a house paraphrase", async () => {
    stubFetch(() => json({ detail: "a public re-perform is capped at 1000 characters" }, 413));
    const r = await post({ text: "x".repeat(2000) });
    expect(r.status).toBe(413);
    expect((await r.json()).detail).toMatch(/capped at 1000 characters/);
  });

  it("answers an unreachable service with the one 503 shape", async () => {
    stubFetch(() => new Error("ECONNREFUSED"));
    const r = await post({ text: "x" });
    expect(r.status).toBe(503);
    expect((await r.json()).detail).toBe("backend unreachable");
  });
});

describe("the body cap", () => {
  it("refuses a body that was never going to be text before the service sees it", async () => {
    const calls = stubFetch(() => json({ take_id: "c" }));
    const r = await post({ text: "x".repeat(9 * 1024) });
    expect(r.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("lets an over-the-service-cap body THROUGH, so the named refusal is what a visitor reads", async () => {
    // The proxy cap (8 KiB) sits far above the service's 1000-character cap on
    // purpose: the visitor should meet the sentence that explains the limit,
    // not a bare 413 from a relay.
    const calls = stubFetch(() => json({ detail: "a public re-perform is capped at 1000 characters" }, 413));
    const r = await post({ text: "x".repeat(4000) });
    expect(calls).toHaveLength(1);
    expect((await r.json()).detail).toMatch(/capped at 1000 characters/);
  });
});
