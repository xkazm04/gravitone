#!/usr/bin/env node
// Gravitone MCP bridge — stdio transport, and nothing else.
//
// Everything interesting lives in ./lib (config, manifest → toolbox, tool call
// → HTTP request, JSON-RPC dispatch), all of it pure and tested with
// `node --test`. This file is the plumbing: read newline-delimited JSON from
// stdin, hand each message to the handler, write each response to stdout.
//
// stdout is the PROTOCOL. Nothing else may be written there — every diagnostic
// goes to stderr, because one stray console.log corrupts the stream and the
// client sees a parse error instead of a tool.

import { createInterface } from "node:readline";

import { ConfigError, loadConfig, manifestUrl } from "./lib/config.mjs";
import { fetchManifest, ManifestError, emptyReason } from "./lib/manifest.mjs";
import { createHandler } from "./lib/rpc.mjs";

const log = (...args) => console.error("[mcp-gravitone]", ...args);

async function main() {
  const config = loadConfig();
  const url = manifestUrl(config);
  log(`reading capability manifest from ${url}`);
  const manifest = await fetchManifest(url);

  const empty = emptyReason(manifest);
  if (empty) log(`WARNING: ${empty}`);
  else log(`key ${manifest.key.prefix} → ${manifest.tools.length} tool(s): ${manifest.tools.map((t) => t.id).join(", ")}`);

  const handle = createHandler(manifest, config);

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // A line we cannot parse has no id, so there is nobody to answer. Say so
      // on stderr rather than emitting a malformed frame onto the protocol.
      log("ignored a line that was not JSON");
      continue;
    }
    let response;
    try {
      response = await handle(message);
    } catch (err) {
      // A crash mid-call must still answer the request it was serving —
      // silence here is a client that waits forever.
      log(`handler error: ${err.stack ?? err.message}`);
      response =
        message?.id === undefined || message?.id === null
          ? null
          : { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: `internal error: ${err.message}` } };
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

main().catch((err) => {
  // A configuration or manifest problem is the operator's to fix, and the
  // message says exactly what to do. Exit non-zero so the MCP client reports a
  // failed server instead of an empty one.
  if (err instanceof ConfigError || err instanceof ManifestError) log(err.message);
  else log(err.stack ?? String(err));
  process.exit(1);
});
