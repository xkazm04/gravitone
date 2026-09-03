// The MCP protocol surface, as a pure message → message function.
//
// MCP over stdio is newline-delimited JSON-RPC 2.0, which is small enough that
// implementing it here beats taking a dependency: this package ships next to
// somebody's agent and its whole promise is "one file, no install". Keeping the
// dispatch pure (no stdin, no stdout, no process) is also what makes the
// protocol testable with `node --test` and no live service anywhere.
//
// Notifications (a message with no `id`) get NO response — returning one for
// `notifications/initialized` is the classic bug that makes a client hang.

import { callTool } from "./call.mjs";
import { emptyReason, toolsFromManifest } from "./manifest.mjs";

export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_INFO = { name: "gravitone", version: "0.1.0" };

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * @param manifest the key manifest — the ONLY source of tools
 * @param config   { apiKey, serviceOverride }
 */
export function createHandler(manifest, config, { fetchImpl = fetch } = {}) {
  const tools = toolsFromManifest(manifest);
  const byName = new Map(manifest.tools.map((t) => [t.id, t]));
  // The manifest names the service; an operator may override it when the
  // studio reports an address only the studio can reach.
  const baseUrl = (config.serviceOverride || manifest.base_url || "").replace(/\/+$/, "");

  return async function handle(message) {
    const { id, method, params } = message ?? {};
    const isNotification = id === undefined || id === null;

    switch (method) {
      case "initialize":
        return isNotification
          ? null
          : ok(id, {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
              // Said once, at handshake, so an operator staring at an empty
              // toolbox learns why instead of assuming the bridge is broken.
              instructions:
                `Gravitone voice tools for key ${manifest.key.prefix} (${manifest.key.scopes.join(", ") || "no scopes"}). ` +
                `Calls go to ${baseUrl}. ` +
                (emptyReason(manifest) ?? `${tools.length} tool(s); anything absent is a scope this key does not hold.`),
            });

      case "notifications/initialized":
      case "notifications/cancelled":
        return null;

      case "ping":
        return isNotification ? null : ok(id, {});

      case "tools/list":
        return isNotification ? null : ok(id, { tools });

      case "tools/call": {
        if (isNotification) return null;
        const name = params?.name;
        const tool = byName.get(name);
        if (!tool) {
          // A tool that is not in the manifest is not "unavailable" — it was
          // never granted. Say which, because the two have different fixes.
          return ok(id, {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `No tool "${name}". This key grants: ${tools.map((t) => t.name).join(", ") || "nothing"}. ` +
                  "A missing tool means a scope this key does not hold — mint a key with that scope.",
              },
            ],
          });
        }
        const result = await callTool(tool, params?.arguments ?? {}, {
          baseUrl,
          apiKey: config.apiKey,
          fetchImpl,
        });
        return ok(id, result);
      }

      default:
        if (isNotification) return null;
        return fail(id, -32601, `method not found: ${method}`);
    }
  };
}
