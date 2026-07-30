// The probe route is a measuring instrument, and an instrument that quietly
// carries the studio's root key measures nothing: every request would be served
// and every deployment would look open-and-scoped at once. So the first test
// here is that the root key is ABSENT, with GRAVITONE_API_KEY deliberately set.
//
// Same harness as app/api/keys/route.test.ts: the real handlers, `fetch`
// stubbed at the backend boundary.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";
import { PROBE_PLAN } from "@/app/keys/_variants/probes";
import type { Sweep } from "@/app/keys/_variants/probes";

type Call = { url: string; init: RequestInit };

/** Route by URL: `status(url)` decides what the backend answers. */
function stubFetch(status: (url: string) => number | Error) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    const s = status(url);
    if (s instanceof Error) throw s;
    return new Response(s === 204 ? null : "{}", { status: s });
  });
  vi.stubGlobal("fetch", f);
  return calls;
}

const post = (body: unknown) =>
  POST(new Request("http://studio.local/api/keys/probe", {
    method: "POST", body: JSON.stringify(body),
  }));

beforeEach(() => {
  // The studio HAS a root key. That is exactly the condition under which the
  // old page could not tell an enforcing backend from an open one.
  vi.stubEnv("GRAVITONE_API_KEY", "root-key-do-not-send");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function keyOf(init: RequestInit): string | null {
  return new Headers(init.headers).get("xi-api-key");
}

describe("GET — posture, measured with no credential at all", () => {
  it("sends the unauthenticated read WITHOUT the studio's root key", async () => {
    const calls = stubFetch(() => 401);
    await GET();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/v1\/voices$/);
    expect(keyOf(calls[0].init)).toBeNull();
  });

  it("calls a refused bare request ENFORCED", async () => {
    stubFetch(() => 401);
    const body = (await (await GET()).json()) as Sweep;
    expect(body.posture).toBe("enforced");
    expect(Date.parse(body.checkedAt)).not.toBeNaN();
  });

  it("calls a SERVED bare request OPEN — the finding this route exists for", async () => {
    stubFetch(() => 200);
    expect(((await (await GET()).json()) as Sweep).posture).toBe("open");
  });

  it("claims no posture for a box that never answered", async () => {
    stubFetch(() => new Error("ECONNREFUSED"));
    expect(((await (await GET()).json()) as Sweep).posture).toBe("unreachable");
  });
});

describe("POST — the scope sweep", () => {
  it("refuses to run without a secret to prove", async () => {
    stubFetch(() => 401);
    expect((await post({ granted: ["tts"] })).status).toBe(400);
  });

  it("presents ONLY the key under test — never the root key", async () => {
    const calls = stubFetch((url) => (url.includes("/v1/voices") && !url.includes("no-such") ? 401 : 200));
    await post({ secret: "gvt_undertest", granted: ["tts"] });
    const [posture, ...sweep] = calls;
    expect(keyOf(posture.init)).toBeNull();          // posture stays bare
    for (const c of sweep) expect(keyOf(c.init)).toBe("gvt_undertest");
  });

  it("runs one probe per grantable scope, and no more", async () => {
    const calls = stubFetch((url) => (url.endsWith("/v1/voices") ? 401 : 200));
    await post({ secret: "s", granted: ["tts"] });
    expect(calls).toHaveLength(PROBE_PLAN.length + 1); // + the posture probe
  });

  it("proves granted scopes and reports ungranted ones as correctly refused", async () => {
    // An enforcing deployment: bare 401, the granted scope served, the rest 401.
    stubFetch((url) => {
      if (url.endsWith("/v1/voices")) return 401;            // posture (bare)
      if (url.includes("/v1/text-to-speech/")) return 200;    // tts, granted
      return 401;
    });
    const body = (await (await post({ secret: "s", granted: ["tts"] })).json()) as Sweep;
    expect(body.posture).toBe("enforced");
    const by = Object.fromEntries(body.probes.map((p) => [p.scope, p.verdict]));
    expect(by.tts).toBe("proven");
    expect(by.clone).toBe("correctly-refused");
    expect(by.convai).toBe("correctly-refused");
    expect(body.negativesConclusive).toBe(true);
  });

  it("flags an ungranted scope that was SERVED anyway", async () => {
    stubFetch((url) => {
      if (url.endsWith("/v1/voices")) return 401;
      if (url.includes("/v1/text-to-speech/")) return 200;
      if (url.includes("/v1/convai/")) return 200; // never granted, served
      return 401;
    });
    const body = (await (await post({ secret: "s", granted: ["tts"] })).json()) as Sweep;
    const convai = body.probes.find((p) => p.scope === "convai");
    expect(convai?.verdict).toBe("REFUSED-SCOPE-SERVED");
    expect(convai?.status).toBe(200);
    expect(convai?.request).toContain("/v1/convai/agents");
  });

  it("reports refusals as inconclusive when nothing granted was served", async () => {
    stubFetch(() => 401);
    const body = (await (await post({ secret: "wrong", granted: ["tts"] })).json()) as Sweep;
    expect(body.negativesConclusive).toBe(false);
    expect(body.probes.find((p) => p.scope === "tts")?.verdict).toBe("granted-but-refused");
  });

  it("stops after the posture probe when nothing answered", async () => {
    // Six more doomed requests would say nothing the silence has not said.
    const calls = stubFetch(() => new Error("ECONNREFUSED"));
    const body = (await (await post({ secret: "s", granted: ["tts"] })).json()) as Sweep;
    expect(body.posture).toBe("unreachable");
    expect(body.probes).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("ignores a granted list full of scopes that do not exist", async () => {
    stubFetch((url) => (url.endsWith("/v1/voices") ? 401 : 401));
    const body = (await (await post({ secret: "s", granted: ["admin", "made-up"] })).json()) as Sweep;
    expect(body.probes.every((p) => p.expected === "refused")).toBe(true);
    expect(body.probes.map((p) => p.scope)).toEqual(PROBE_PLAN.map((p) => p.scope));
  });
});
