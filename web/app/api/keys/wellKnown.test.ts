// /.well-known/gravitone.json — the deployment half of the handshake.
//
// The test file lives here rather than beside the route because vitest's
// include glob does not descend into dotted directories (`app/.well-known/…`),
// and a test that is never collected is worse than no test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/.well-known/gravitone.json/route";
import { AUDIO_FORMATS, CAPABILITIES, SCOPES } from "@/app/keys/_variants/capabilities";

const doc = async () => (await (await GET()).json()) as Record<string, unknown>;

beforeEach(() => { vi.stubEnv("GRAVITONE_PUBLIC_URL", "https://voice.example.com"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("what a client with only a host can learn", () => {
  it("names the base URL, where it came from, and the auth header", async () => {
    const d = await doc();
    expect(d.base_url).toBe("https://voice.example.com");
    expect(d.base_url_source).toBe("GRAVITONE_PUBLIC_URL");
    expect((d.auth as { header: string }).header).toBe("xi-api-key");
  });

  it("says a loopback URL is a loopback URL instead of pretending it is public", async () => {
    vi.unstubAllEnvs();
    const d = await doc();
    expect(d.base_url_source).toBe("default");
    expect(d.base_url_note).toMatch(/GRAVITONE_PUBLIC_URL/);
  });

  it("states the CORS reality that breaks every first browser call", async () => {
    const cors = (await doc()).cors as Record<string, string>;
    expect(cors.browser_calls).toMatch(/blocked/);
    expect(cors.enable).toMatch(/TTS_CORS_ORIGINS/);
    expect(cors.recommended).toMatch(/server/);
  });

  it("publishes the format grammar the service's parser actually accepts", async () => {
    const formats = (await doc()).formats as typeof AUDIO_FORMATS & { note: string };
    expect(formats.default).toBe(AUDIO_FORMATS.default);
    expect(formats.mp3_bitrates).toEqual([...AUDIO_FORMATS.mp3_bitrates]);
    expect(formats.note).toMatch(/400/); // an unsupported value is refused, not silently swapped
  });

  it("lists the deployment's capabilities and the scopes that gate them", async () => {
    const d = await doc();
    expect((d.capabilities as unknown[]).length).toBe(CAPABILITIES.length);
    expect((d.scopes as { id: string }[]).map((s) => s.id)).toEqual(SCOPES.map((s) => s.id));
  });

  it("does not let a capability listing read as a grant", async () => {
    expect((await doc()).capability_note).toMatch(/not that your key may call it/);
  });

  it("claims NO posture — enforcement is measurable, not declarable", async () => {
    const text = JSON.stringify(await doc());
    expect(text).not.toMatch(/"enforced"/);
    expect((await doc()).auth).toMatchObject({ note: expect.stringContaining("TTS_API_KEY") });
  });

  it("points at the per-key manifest for the credential-level boundary", async () => {
    const discovery = (await doc()).discovery as Record<string, string>;
    expect(discovery.key_manifest).toContain("/manifest");
    expect(discovery.mcp_bridge).toContain("mcp-gravitone");
  });
});
