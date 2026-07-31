// THE DRIFT TEST.
//
// A capability manifest that names an endpoint the service does not serve is
// worse than no manifest: an agent plans around a tool that 404s, and nothing
// tells anybody until it fails in somebody else's runtime. So every capability
// is checked against `serviceRoutes.ts` — a snapshot of what `service/`
// actually mounts, updated deliberately (its header says how) and never
// silently.
//
// If one of these fails, the fix is NOT to loosen the assertion. Either the
// capability table is wrong, or the snapshot is stale — the failure message
// says which to look at.

import { describe, expect, it } from "vitest";

import {
  AUDIO_FORMATS,
  CAPABILITIES,
  SCOPES,
  capabilitiesFor,
  foldProof,
  scopesWithoutCapabilities,
  type KeyManifest,
} from "./capabilities";
import { SERVICE_ROUTES, UNGRANTABLE_SCOPES, findRoute } from "./serviceRoutes";
import {
  emptyToolboxReason,
  mcpServerConfig,
  openAiTools,
  toolInputSchema,
  SECRET_PLACEHOLDER,
  SECRET_REF,
} from "./agentConfig";

const UPDATE =
  "Fix the capability table, or re-derive serviceRoutes.ts from service/ (its header has the grep) and update it deliberately.";

describe("drift — every capability names a route the service really serves", () => {
  for (const cap of CAPABILITIES) {
    it(`${cap.id} → ${cap.method} ${cap.endpoint}`, () => {
      const route = findRoute(cap.method, cap.endpoint);
      expect(
        route,
        `${cap.id} claims ${cap.method} ${cap.endpoint}, which is not in the checked service route list. ${UPDATE}`,
      ).toBeDefined();
      expect(
        route?.scope,
        `${cap.id} is filed under the "${cap.scope}" scope but ${cap.method} ${cap.endpoint} is guarded by ` +
          `"${route?.scope}". A key granted ${cap.scope} would be refused there. ${UPDATE}`,
      ).toBe(cap.scope);
    });
  }

  it("never offers a capability a managed key could not hold", () => {
    // Managed keys are never valid for `admin` (service/auth.py), so a
    // capability naming a key-management route could never work.
    const forbidden = CAPABILITIES.filter((c) => (UNGRANTABLE_SCOPES as readonly string[]).includes(c.scope));
    expect(forbidden.map((c) => c.id)).toEqual([]);
  });

  it("only uses scopes the service can actually grant", () => {
    const grantable = new Set(SCOPES.map((s) => s.id));
    for (const c of CAPABILITIES) {
      expect(grantable.has(c.scope), `${c.id} uses scope "${c.scope}", which is not grantable`).toBe(true);
    }
  });

  it("keeps every grantable scope represented, so no scope is a dead chip", () => {
    const covered = new Set(CAPABILITIES.map((c) => c.scope));
    for (const s of SCOPES) {
      expect(
        covered.has(s.id),
        `scope "${s.id}" grants no capability, so a key holding it produces an empty toolbox. ` +
          "Add a capability for it (a cheap read is enough) or say so deliberately.",
      ).toBe(true);
    }
  });

  it("has a unique id per capability — the id IS the agent's tool name", () => {
    expect(new Set(CAPABILITIES.map((c) => c.id)).size).toBe(CAPABILITIES.length);
  });

  it("keeps the snapshot itself free of duplicates", () => {
    const seen = SERVICE_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("declares a format grammar the service's parser accepts", () => {
    // _parse_format's tables, mirrored. A rate that drifts out of this list is
    // a 400 for the agent that believed the well-known document.
    for (const r of AUDIO_FORMATS.mp3_sample_rates) {
      expect(AUDIO_FORMATS.pcm_sample_rates as readonly number[]).toContain(r);
    }
    expect(AUDIO_FORMATS.pcm_sample_rates as readonly number[]).toContain(AUDIO_FORMATS.native_sample_rate);
    expect(AUDIO_FORMATS.default).toBe(`wav_${AUDIO_FORMATS.native_sample_rate}`);
  });
});

describe("the boundary — a key's scopes are the toolbox", () => {
  it("gives a key only the capabilities its scopes grant", () => {
    expect(capabilitiesFor(["tts"]).every((c) => c.scope === "tts")).toBe(true);
    expect(capabilitiesFor(["tts"]).map((c) => c.id)).toContain("speak");
    expect(capabilitiesFor(["tts"]).map((c) => c.id)).not.toContain("perform");
  });

  it("gives a scopeless key nothing at all", () => {
    expect(capabilitiesFor([])).toEqual([]);
  });

  it("ignores a scope that does not exist rather than inventing a tool", () => {
    expect(capabilitiesFor(["made-up"])).toEqual([]);
  });

  it("reports a granted scope that carries no capability instead of dropping it", () => {
    expect(scopesWithoutCapabilities(["tts", "future-scope"])).toEqual(["future-scope"]);
    expect(scopesWithoutCapabilities(["tts"])).toEqual([]);
  });
});

// ── proof folding ───────────────────────────────────────────────────────────

function manifest(overrides: Partial<KeyManifest> = {}): KeyManifest {
  return {
    manifest_version: 1,
    generated_at: "2026-07-30T12:00:00.000Z",
    base_url: "https://voice.example.com",
    auth: { header: "xi-api-key", alternate: "Bearer", note: "" },
    key: { id: "k1", name: "Agent", prefix: "gvt_abc", scopes: ["tts", "performance"], revoked: false },
    tools: capabilitiesFor(["tts", "performance"]).map((c) => ({ ...c, proven: "unknown" as const })),
    boundary: "",
    proof: { source: "none", note: "" },
    uncovered_scopes: [],
    ...overrides,
  };
}

const PROOF = {
  proven: ["tts"],
  grantedButRefused: ["performance"],
  posture: "enforced",
  checkedAt: "2026-07-30T11:00:00.000Z",
};

describe("foldProof — a proof counts only where it means something", () => {
  it("marks probed scopes proven and refused ones false", () => {
    const m = foldProof(manifest(), PROOF);
    const by = Object.fromEntries(m.tools.map((t) => [t.id, t.proven]));
    expect(by.speak).toBe("true");
    expect(by.perform).toBe("false");
  });

  it("leaves everything unknown when there is no proof", () => {
    expect(foldProof(manifest(), null).tools.every((t) => t.proven === "unknown")).toBe(true);
  });

  it("ignores a RETIRED proof — a stale matrix is not evidence", () => {
    const m = foldProof(manifest(), { ...PROOF, stale: true });
    expect(m.tools.every((t) => t.proven === "unknown")).toBe(true);
  });

  it("ignores a proof taken on an OPEN deployment, where serving proves no privilege", () => {
    const m = foldProof(manifest(), { ...PROOF, posture: "open" });
    expect(m.tools.every((t) => t.proven === "unknown")).toBe(true);
  });

  it("stamps the proof's timestamp on the manifest it folded into", () => {
    expect(foldProof(manifest(), PROOF).proof.note).toContain(PROOF.checkedAt);
  });
});

// ── the generated blocks ────────────────────────────────────────────────────

describe("agent config blocks", () => {
  it("references an env var by default and never leaks the secret", () => {
    const block = mcpServerConfig(manifest(), { mode: "env" }, "http://studio.local");
    expect(block).toContain(SECRET_REF);
    expect(block).not.toContain("gvt_realsecret");
    expect(JSON.parse(block).mcpServers.gravitone.env.GRAVITONE_STUDIO_URL).toBe("http://studio.local");
  });

  it("inlines the raw secret only when asked", () => {
    const block = mcpServerConfig(manifest(), { mode: "inline", secret: "gvt_realsecret" }, "http://studio.local/");
    expect(JSON.parse(block).mcpServers.gravitone.env.GRAVITONE_API_KEY).toBe("gvt_realsecret");
  });

  it("renders a placeholder — not an empty string — when the secret is gone", () => {
    const block = mcpServerConfig(manifest(), { mode: "inline", secret: null }, "http://studio.local");
    expect(JSON.parse(block).mcpServers.gravitone.env.GRAVITONE_API_KEY).toBe(SECRET_PLACEHOLDER);
  });

  it("names both hosts, because they are not the same host", () => {
    const env = JSON.parse(mcpServerConfig(manifest(), { mode: "env" }, "http://studio.local")).mcpServers.gravitone.env;
    expect(env.GRAVITONE_STUDIO_URL).toBe("http://studio.local");
    expect(env.GRAVITONE_URL).toBe("https://voice.example.com");
  });

  it("emits one OpenAI tool per manifest tool, with its endpoint", () => {
    const tools = JSON.parse(openAiTools(manifest())) as { function: { name: string }; "x-gravitone": { url: string } }[];
    expect(tools.map((t) => t.function.name)).toEqual(manifest().tools.map((t) => t.id));
    expect(tools[0]["x-gravitone"].url).toContain("https://voice.example.com/v1/");
  });

  it("warns in the tool description when a probe REFUSED the capability", () => {
    const tools = JSON.parse(openAiTools(foldProof(manifest(), PROOF))) as { function: { name: string; description: string } }[];
    const perform = tools.find((t) => t.function.name === "perform");
    expect(perform?.function.description).toMatch(/WARNING/);
  });

  it("derives a JSON Schema whose required list is the required params", () => {
    const speak = CAPABILITIES.find((c) => c.id === "speak")!;
    const schema = toolInputSchema(speak);
    expect(schema.required).toEqual(["voice_id", "text"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("explains an empty toolbox instead of rendering a config that installs nothing", () => {
    expect(emptyToolboxReason(manifest())).toBeNull();
    expect(
      emptyToolboxReason(manifest({ tools: [], key: { id: "k", name: "n", prefix: "p", scopes: ["tts"], revoked: true } })),
    ).toMatch(/revoked/);
    expect(
      emptyToolboxReason(manifest({ tools: [], key: { id: "k", name: "n", prefix: "p", scopes: [], revoked: false } })),
    ).toMatch(/no agent-callable capability/);
  });
});
