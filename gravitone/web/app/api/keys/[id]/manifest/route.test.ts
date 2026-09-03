// The manifest route is a derivation, so these tests are about what it refuses
// to say: no tool outside the key's scopes, no toolbox for a revoked key, no
// proof it does not have, and no manifest at all when the key list could not be
// read (an empty toolbox and an unreachable backend must never look alike).
//
// Same harness as the sibling key routes: real handler, `fetch` stubbed at the
// backend boundary.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";
import type { KeyManifest } from "@/app/keys/_variants/capabilities";

type BackendKey = { id: string; name: string; prefix: string; scopes: string[]; revoked?: boolean };

const KEYS: BackendKey[] = [
  { id: "k1", name: "Agent key", prefix: "gvt_abc", scopes: ["tts"], revoked: false },
  { id: "k2", name: "Everything", prefix: "gvt_def", scopes: ["tts", "performance", "stt", "voices", "clone", "convai"] },
  { id: "k3", name: "Dead", prefix: "gvt_ghi", scopes: ["tts", "performance"], revoked: true },
];

function stubKeys(body: unknown = KEYS, status = 200) {
  const f = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", f);
  return f;
}

const get = (id: string) =>
  GET(new Request(`http://studio.local/api/keys/${id}/manifest`) as never, { params: Promise.resolve({ id }) });

const body = async (id: string) => (await (await get(id)).json()) as KeyManifest;

beforeEach(() => {
  vi.stubEnv("GRAVITONE_PUBLIC_URL", "https://voice.example.com");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("the toolbox stops at the key's scopes", () => {
  it("exposes only the capabilities a tts-only key grants", async () => {
    stubKeys();
    const m = await body("k1");
    expect(m.tools.length).toBeGreaterThan(0);
    expect(m.tools.every((t) => t.scope === "tts")).toBe(true);
    expect(m.tools.map((t) => t.id)).toContain("speak");
    // ABSENT, not disabled: an agent never learns the call exists.
    expect(m.tools.map((t) => t.id)).not.toContain("perform");
    expect(m.tools.map((t) => t.id)).not.toContain("transcribe");
  });

  it("grows with the scopes", async () => {
    stubKeys();
    const m = await body("k2");
    expect(m.tools.map((t) => t.id)).toEqual(
      expect.arrayContaining(["speak", "perform", "transcribe", "update_voice", "list_agents"]),
    );
  });

  it("gives a REVOKED key an empty toolbox and says why", async () => {
    stubKeys();
    const m = await body("k3");
    expect(m.tools).toEqual([]);
    expect(m.key.revoked).toBe(true);
    expect(m.boundary).toMatch(/REVOKED/);
  });
});

describe("what it will not claim", () => {
  it("proves nothing — the server has no attestation to read", async () => {
    stubKeys();
    const m = await body("k1");
    expect(m.tools.every((t) => t.proven === "unknown")).toBe(true);
    expect(m.proof.source).toBe("none");
  });

  it("refuses a caller's assertion of a proof", async () => {
    stubKeys();
    // A query string claiming proven scopes must change nothing: a claim about
    // a probe is not a probe.
    const r = await GET(
      new Request("http://studio.local/api/keys/k1/manifest?proven=tts,performance") as never,
      { params: Promise.resolve({ id: "k1" }) },
    );
    const m = (await r.json()) as KeyManifest;
    expect(m.tools.every((t) => t.proven === "unknown")).toBe(true);
  });

  it("404s a key that does not exist rather than serving an empty manifest", async () => {
    stubKeys();
    expect((await get("nope")).status).toBe(404);
  });

  it("503s when the key list could not be read — an unreachable backend is not an empty toolbox", async () => {
    stubKeys({ detail: "nope" }, 500);
    expect((await get("k1")).status).toBe(503);
  });

  it("503s when the backend never answered", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect((await get("k1")).status).toBe(503);
  });
});

describe("the deployment half", () => {
  it("reports the operator's public URL with no caveat", async () => {
    stubKeys();
    const m = (await body("k1")) as KeyManifest & { base_url_note?: string };
    expect(m.base_url).toBe("https://voice.example.com");
    expect(m.base_url_note).toBeUndefined();
    expect(m.auth.header).toBe("xi-api-key");
  });

  it("carries a caveat when only the studio's internal URL is known", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("GRAVITONE_URL", "http://127.0.0.1:8080");
    stubKeys();
    const m = (await body("k1")) as KeyManifest & { base_url_note?: string };
    expect(m.base_url).toBe("http://127.0.0.1:8080");
    expect(m.base_url_note).toMatch(/GRAVITONE_PUBLIC_URL/);
  });

  it("is never cached — a manifest describes access that can be revoked", async () => {
    stubKeys();
    expect((await get("k1")).headers.get("Cache-Control")).toBe("no-store");
  });
});
