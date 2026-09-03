// The protocol surface: handshake, listing, calling, and the two ways a client
// hangs (an answered notification, an unanswered request).

import assert from "node:assert/strict";
import { test } from "node:test";

import { createHandler, PROTOCOL_VERSION } from "../lib/rpc.mjs";
import { jsonResponse, manifestFixture, stubFetch } from "./fixture.mjs";

const CONFIG = { apiKey: "gvt_secret", serviceOverride: "" };

function handler(manifest = manifestFixture(), fetchImpl = stubFetch(() => jsonResponse({}))) {
  return { handle: createHandler(manifest, CONFIG, { fetchImpl }), fetchImpl };
}

test("initialize answers with the protocol version and what this key opens", async () => {
  const { handle } = handler();
  const res = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(res.result.protocolVersion, PROTOCOL_VERSION);
  assert.match(res.result.instructions, /gvt_abc/);
  assert.match(res.result.instructions, /3 tool/);
});

test("initialize on a revoked key says the toolbox is empty and why", async () => {
  const m = manifestFixture({ tools: [], key: { id: "k1", name: "x", prefix: "gvt_a", scopes: ["tts"], revoked: true } });
  const { handle } = handler(m);
  const res = await handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.match(res.result.instructions, /REVOKED/);
});

test("a notification is never answered", async () => {
  const { handle } = handler();
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("tools/list returns exactly the manifest's tools", async () => {
  const { handle } = handler();
  const res = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(res.result.tools.map((t) => t.name), ["speak", "list_voices", "transcribe"]);
  assert.equal(res.result.tools[0].inputSchema.type, "object");
});

test("tools/call reaches the service the manifest names, with the key", async () => {
  const f = stubFetch(() => jsonResponse({ voices: [] }));
  const { handle } = handler(manifestFixture(), f);
  const res = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_voices", arguments: {} } });
  assert.equal(f.calls[0].url, "https://voice.example.com/v1/voices");
  assert.equal(f.calls[0].init.headers["xi-api-key"], "gvt_secret");
  assert.equal(res.result.isError, undefined);
});

test("GRAVITONE_URL overrides the manifest's base URL", async () => {
  const f = stubFetch(() => jsonResponse({}));
  const handle = createHandler(manifestFixture(), { ...CONFIG, serviceOverride: "http://10.0.0.5:8080" }, { fetchImpl: f });
  await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_voices" } });
  assert.equal(f.calls[0].url, "http://10.0.0.5:8080/v1/voices");
});

test("a tool outside the manifest is refused as a SCOPE the key lacks", async () => {
  const f = stubFetch(() => jsonResponse({}));
  const { handle } = handler(manifestFixture(), f);
  const res = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "perform", arguments: {} } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /scope this key does not hold/);
  // And crucially: no request was made on the key's behalf.
  assert.equal(f.calls.length, 0);
});

test("an unknown method is a JSON-RPC error, not silence", async () => {
  const { handle } = handler();
  const res = await handle({ jsonrpc: "2.0", id: 6, method: "resources/list" });
  assert.equal(res.error.code, -32601);
});

test("ping answers", async () => {
  const { handle } = handler();
  assert.deepEqual((await handle({ jsonrpc: "2.0", id: 7, method: "ping" })).result, {});
});
