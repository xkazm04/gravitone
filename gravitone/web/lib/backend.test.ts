// What every proxy route sends upstream, asserted once at the door they all
// leave by. Two properties live here and nowhere else:
//
//   1. the CREDENTIAL is never implicit — the root key goes out when a call
//      site asked for it and never otherwise;
//   2. the CALLER's address is forwarded, so the service's per-IP budget
//      counts callers rather than counting this process once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backendFetch, proxyJson } from "./backend";

const { incoming } = vi.hoisted(() => ({ incoming: { value: new Headers() } }));
vi.mock("next/headers", () => ({ headers: async () => incoming.value }));

const savedKey = process.env.GRAVITONE_API_KEY;

function stub() {
  const fn = vi.fn(async (..._args: unknown[]) => new Response("{}", {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The headers the backend would actually receive. */
const sent = (fn: ReturnType<typeof stub>) => {
  const [, init] = fn.mock.calls[0] as [string, RequestInit];
  return new Headers(init.headers as HeadersInit);
};

beforeEach(() => {
  process.env.GRAVITONE_API_KEY = "root-secret";
  incoming.value = new Headers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env.GRAVITONE_API_KEY;
  else process.env.GRAVITONE_API_KEY = savedKey;
});

describe("the credential is never implicit", () => {
  it("attaches the root key when a call site asks for the operator", async () => {
    const f = stub();
    await backendFetch("/v1/voices", { credential: "operator" });
    expect(sent(f).get("xi-api-key")).toBe("root-secret");
  });

  it("sends NOTHING when a call site asks for none", async () => {
    // The proving route depends on this: a request carrying the root key
    // measures the root key, not the deployment.
    const f = stub();
    await backendFetch("/v1/voices", { credential: "none" });
    expect(sent(f).has("xi-api-key")).toBe(false);
    expect(sent(f).has("authorization")).toBe(false);
  });

  it("never overrides a credential the call site set by hand", async () => {
    const f = stub();
    await backendFetch("/v1/voices", {
      credential: "operator",
      headers: { "xi-api-key": "the-key-under-test" },
    });
    expect(sent(f).get("xi-api-key")).toBe("the-key-under-test");
  });

  it("carries no key at all when the deployment has none configured", async () => {
    delete process.env.GRAVITONE_API_KEY;
    const f = stub();
    await backendFetch("/v1/voices", { credential: "operator" });
    expect(sent(f).has("xi-api-key")).toBe(false);
  });
});

describe("the caller's address reaches the per-IP limiter", () => {
  it("forwards x-forwarded-for from the incoming request", async () => {
    incoming.value = new Headers({ "x-forwarded-for": "203.0.113.7" });
    const f = stub();
    await proxyJson("/v1/speak", { credential: "operator", method: "POST" });
    expect(sent(f).get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("forwards the WHOLE chain, so the service can count its own trusted hops", async () => {
    // service/ratelimit.py reads the Nth entry from the RIGHT. Rewriting the
    // chain here — keeping only the leftmost, say — would hand it the entry a
    // client chose for itself.
    incoming.value = new Headers({ "x-forwarded-for": "198.51.100.9, 203.0.113.7" });
    const f = stub();
    await backendFetch("/v1/takes/t1/reperform", { credential: "operator", method: "POST" });
    expect(sent(f).get("x-forwarded-for")).toBe("198.51.100.9, 203.0.113.7");
  });

  it("leaves a call site's own explicit value alone", async () => {
    incoming.value = new Headers({ "x-forwarded-for": "203.0.113.7" });
    const f = stub();
    await backendFetch("/v1/takes/t1/reperform", {
      credential: "operator",
      headers: { "x-forwarded-for": "192.0.2.1" },
    });
    expect(sent(f).get("x-forwarded-for")).toBe("192.0.2.1");
  });

  it("forwards nothing when the studio sits behind no proxy", async () => {
    // Not "unknown", not this process's address: a header the service would
    // then trust as the caller's would be a lie that puts everyone in one
    // bucket under a different name.
    const f = stub();
    await backendFetch("/v1/voices", { credential: "operator" });
    expect(sent(f).has("x-forwarded-for")).toBe(false);
  });
});
