// The manifest IS the toolbox.
//
// This module does two things and refuses to do a third: it fetches one key's
// capability manifest, and it turns that manifest's tools into MCP tool
// descriptors. It has NO built-in tool list. If Gravitone grows a capability
// and the key holds its scope, the tool appears here without a line changing;
// if the key does not hold the scope, the tool is absent — not disabled, not
// hidden behind a flag. The key's scopes are the agent's real boundary only if
// this file never invents a tool the manifest did not name.
//
// Zero dependencies on purpose: the schema derivation below mirrors
// web/app/keys/_variants/agentConfig.ts::toolInputSchema, which this package
// cannot import (it is a separate, dependency-free package that ships next to
// an agent, not next to the studio). Both sides are pinned by tests.

export class ManifestError extends Error {}

const JSON_TYPE = {
  string: "string",
  number: "number",
  boolean: "boolean",
  object: "object",
  array: "array",
};

/** Fetch and validate the manifest. A malformed document is an error, never a
 *  half-toolbox: a bridge that silently exposed the three tools it could parse
 *  would be lying about the key's boundary. */
export async function fetchManifest(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ManifestError(`could not reach the studio at ${url} to read the key manifest: ${err.message}`);
  }
  if (!res.ok) {
    throw new ManifestError(
      `the studio answered ${res.status} for ${url}. 404 means no key with that GRAVITONE_KEY_ID; ` +
        "503 means the studio could not reach the Gravitone service.",
    );
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new ManifestError(`${url} did not return JSON — is GRAVITONE_STUDIO_URL pointing at the studio?`);
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.tools)) {
    throw new ManifestError(`${url} returned a document with no tools array; this is not a key manifest.`);
  }
  if (body.manifest_version !== 1) {
    throw new ManifestError(
      `manifest_version ${body.manifest_version} is not one this bridge can read (it understands 1). ` +
        "Update agents/mcp-gravitone rather than guessing at the new shape.",
    );
  }
  return body;
}

/** JSON Schema for one capability's arguments. `file` parameters become base64
 *  strings — a tool call carries JSON, and this bridge is the thing that turns
 *  that back into a multipart upload. */
export function inputSchema(tool) {
  const properties = {};
  const required = [];
  for (const p of tool.params ?? []) {
    properties[p.name] = {
      type: p.in === "file" ? "string" : (JSON_TYPE[p.type] ?? "string"),
      description: p.in === "file" ? `${p.description} Base64-encoded.` : p.description,
      ...(p.enum ? { enum: p.enum } : {}),
    };
    if (p.required) required.push(p.name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/** The description an agent reads. A capability a probe REFUSED must not read
 *  like one that works, and one nobody checked must not read like one that was
 *  proved — the manifest's `proven` field is the difference and it is stated. */
export function describe(tool) {
  const proof =
    tool.proven === "true"
      ? " (Proven against this deployment.)"
      : tool.proven === "false"
        ? " (WARNING: this deployment REFUSED this scope when probed — expect 401/403.)"
        : "";
  const notes = (tool.notes ?? []).map((n) => ` Note: ${n}`).join("");
  return `${tool.summary}${proof}${notes}`;
}

/** MCP tool descriptors — exactly the manifest's tools, in its order. */
export function toolsFromManifest(manifest) {
  return manifest.tools.map((t) => ({
    name: t.id,
    description: describe(t),
    inputSchema: inputSchema(t),
  }));
}

/** Why a toolbox is empty, in words an agent's operator can act on. Returns
 *  null when it is not. */
export function emptyReason(manifest) {
  if (manifest.tools.length > 0) return null;
  if (manifest.key?.revoked) {
    return "This key is REVOKED: it authenticates nothing, so the bridge exposes no tools. Rotate it in the studio.";
  }
  return (
    `This key holds no scope with an agent-callable capability (scopes: ${(manifest.key?.scopes ?? []).join(", ") || "none"}). ` +
    "Mint a key with the scopes you need."
  );
}
