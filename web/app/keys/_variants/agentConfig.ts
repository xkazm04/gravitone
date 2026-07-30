// The agent-facing install blocks, generated from a key manifest.
//
// Two shapes, because there are two kinds of runtime: an MCP client reads a
// server config and launches the bridge; everything else (OpenAI-style tool
// loaders, LangChain, a hand-rolled loop) reads a tool-schema array and calls
// the HTTP endpoints itself. Both are derived from the SAME manifest, so a
// scope the key does not hold is missing from both.
//
// ── secrets ─────────────────────────────────────────────────────────────────
// An agent config is a FILE. It gets committed, synced, pasted into issues and
// read by the next tool that wants a credential. So the default is an env-var
// REFERENCE (`${GRAVITONE_API_KEY}`) and the raw secret is opt-in, once, with
// the reason stated where the choice is made — not a preference buried in a
// settings page. `inlineSecret` without a secret in hand is not an error and
// not silently ignored: it renders the placeholder, because the studio shows a
// secret exactly once and cannot conjure it back.
//
// Pure: no React, no fetch, no storage. The bridge derives its own schemas from
// the manifest it fetches at runtime (agents/mcp-gravitone is a zero-dependency
// package that cannot import this one) — `capabilities.test.ts` and the
// bridge's own tests both pin the shape so the two derivations agree.

import type { Capability, CapabilityParam, KeyManifest } from "./capabilities";

/** The env var both blocks reference, and the one the bridge reads. */
export const SECRET_ENV = "GRAVITONE_API_KEY";
export const SECRET_PLACEHOLDER = "YOUR_GRAVITONE_KEY";
/** What goes in the config when the secret stays out of it. */
export const SECRET_REF = `\${${SECRET_ENV}}`;

export type SecretMode =
  /** Default: the config points at an environment variable. */
  | { mode: "env" }
  /** Opt-in: the raw secret is written into the file. `secret` may be null when
   *  it is gone (an existing ledger row), which renders the placeholder. */
  | { mode: "inline"; secret: string | null };

export const WHY_ENV_BY_DEFAULT =
  "Agent configs get committed. The block below references an environment variable so the secret " +
  "never enters the file — export it in the shell that launches your agent.";

export const WHY_INLINE_COSTS =
  "The raw secret is now IN this text. Anything that reads the config reads the key: commit it and " +
  "it is leaked. Paste it into a file your VCS ignores, or rotate the key the moment it escapes.";

/** A secret that is gone cannot be re-shown — say what to do instead. */
export const SECRET_GONE =
  "This key's secret was shown once, at mint, and is not stored. The block carries a placeholder: " +
  "rotate the key to get a new secret (rotation invalidates the old one), or export the value you saved.";

function secretValue(s: SecretMode): string {
  if (s.mode === "env") return SECRET_REF;
  return s.secret ?? SECRET_PLACEHOLDER;
}

// ── JSON Schema ─────────────────────────────────────────────────────────────

const JSON_TYPE: Record<CapabilityParam["type"], string> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  object: "object",
  array: "array",
};

/** A capability's parameters as a JSON Schema an agent runtime can validate
 *  against. `file` parameters become base64 strings: a tool call carries JSON,
 *  and the bridge is the thing that turns that back into a multipart upload. */
export function toolInputSchema(cap: Capability): {
  type: "object";
  properties: Record<string, { type: string; description: string; enum?: readonly string[] }>;
  required: string[];
  additionalProperties: false;
} {
  const properties: Record<string, { type: string; description: string; enum?: readonly string[] }> = {};
  const required: string[] = [];
  for (const p of cap.params) {
    properties[p.name] = {
      type: p.in === "file" ? "string" : JSON_TYPE[p.type],
      description: p.in === "file" ? `${p.description} Base64-encoded.` : p.description,
      ...(p.enum ? { enum: p.enum } : {}),
    };
    if (p.required) required.push(p.name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/** The tool description an agent reads. Proof state is part of it: a capability
 *  a probe REFUSED must not read like one that works, and one nobody checked
 *  must not read like one that was proved. */
export function toolDescription(cap: Capability, proven: string): string {
  const suffix =
    proven === "true"
      ? " (Proved: this deployment served it for this key.)"
      : proven === "false"
        ? " (WARNING: granted on paper, but a probe was REFUSED here — expect a 401/403.)"
        : "";
  return `${cap.summary}${suffix}`;
}

// ── the two blocks ──────────────────────────────────────────────────────────

/** MCP client config for the in-repo stdio bridge. Shaped for the standard
 *  `mcpServers` map (Claude Desktop, Claude Code and friends read this).
 *
 *  TWO hosts, and conflating them is the mistake this signature prevents:
 *  `GRAVITONE_STUDIO_URL` is where the MANIFEST lives (this studio — the bridge
 *  asks it what the key opens), and `GRAVITONE_URL` is the SERVICE the tools
 *  actually call. They are the same box only by coincidence. */
export function mcpServerConfig(manifest: KeyManifest, secret: SecretMode, studioUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        gravitone: {
          command: "node",
          args: ["agents/mcp-gravitone/server.mjs"],
          env: {
            GRAVITONE_STUDIO_URL: studioUrl.replace(/\/+$/, ""),
            GRAVITONE_KEY_ID: manifest.key.id,
            GRAVITONE_URL: manifest.base_url,
            [SECRET_ENV]: secretValue(secret),
          },
        },
      },
    },
    null,
    2,
  );
}

/** OpenAI-style tool schemas for a runtime that calls the HTTP API itself.
 *  Each tool carries its endpoint and method in the description block's
 *  companion `x-gravitone` field — a loader that ignores it still gets a valid
 *  function schema, and one that reads it needs no second document. */
export function openAiTools(manifest: KeyManifest): string {
  const tools = manifest.tools.map((t) => ({
    type: "function",
    function: {
      name: t.id,
      description: toolDescription(t, t.proven),
      parameters: toolInputSchema(t),
    },
    "x-gravitone": {
      method: t.method,
      url: `${manifest.base_url}${t.endpoint}`,
      auth_header: manifest.auth.header,
      scope: t.scope,
      proven: t.proven,
      returns: t.response.kind,
      notes: t.notes,
    },
  }));
  return JSON.stringify(tools, null, 2);
}

/** The one-liner that makes the tool schemas usable: where the key goes. */
export function httpAuthHint(manifest: KeyManifest, secret: SecretMode): string {
  return `${manifest.auth.header}: ${secretValue(secret)}`;
}

/** An empty toolbox is a RESULT, not an error state — a revoked key, or one
 *  whose scopes carry no capability. Say which. */
export function emptyToolboxReason(manifest: KeyManifest): string | null {
  if (manifest.tools.length > 0) return null;
  return manifest.key.revoked
    ? "This key is revoked, so it opens nothing. The config below would install an empty toolbox — rotate or mint a key first."
    : "This key's scopes carry no agent-callable capability, so the toolbox is empty. Grant it a scope with tools (synthesize, performance, transcribe…) by minting a new key.";
}
