// The toolbox is the manifest, and these tests exist to keep it that way: no
// built-in tool list, no tool that survives a scope the key does not hold, no
// half-toolbox from a document the bridge could not fully understand.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, loadConfig, manifestUrl, DEFAULT_STUDIO_URL } from "../lib/config.mjs";
import { describe, emptyReason, fetchManifest, inputSchema, ManifestError, toolsFromManifest } from "../lib/manifest.mjs";
import { jsonResponse, manifestFixture, stubFetch } from "./fixture.mjs";

test("exposes exactly the manifest's tools, in its order", () => {
  const tools = toolsFromManifest(manifestFixture());
  assert.deepEqual(tools.map((t) => t.name), ["speak", "list_voices", "transcribe"]);
});

test("a tool the key's scopes do not grant is ABSENT, not disabled", () => {
  // The studio omits `perform` for a key without the performance scope; the
  // bridge must not resurrect it from any built-in knowledge.
  const tools = toolsFromManifest(manifestFixture());
  assert.equal(tools.find((t) => t.name === "perform"), undefined);
});

test("a revoked key opens nothing, and says why", () => {
  const m = manifestFixture({ tools: [], key: { id: "k1", name: "x", prefix: "gvt_a", scopes: ["tts"], revoked: true } });
  assert.deepEqual(toolsFromManifest(m), []);
  assert.match(emptyReason(m), /REVOKED/);
});

test("an empty toolbox on a live key names the scopes it has", () => {
  const m = manifestFixture({ tools: [], key: { id: "k1", name: "x", prefix: "gvt_a", scopes: ["clone"], revoked: false } });
  assert.match(emptyReason(m), /clone/);
});

test("input schema puts required params in required and marks file params base64", () => {
  const m = manifestFixture();
  const speak = inputSchema(m.tools[0]);
  assert.deepEqual(speak.required, ["voice_id", "text"]);
  assert.equal(speak.properties.output_format.type, "string");
  assert.equal(speak.additionalProperties, false);

  const transcribe = inputSchema(m.tools[2]);
  assert.equal(transcribe.properties.file.type, "string");
  assert.match(transcribe.properties.file.description, /Base64/);
});

test("a refused capability does not read like a working one", () => {
  const m = manifestFixture();
  assert.match(describe(m.tools[2]), /REFUSED/);          // proven: "false"
  assert.match(describe(m.tools[1]), /Proven/);           // proven: "true"
  assert.doesNotMatch(describe(m.tools[0]), /Proven|REFUSED/); // unknown says neither
});

test("fetchManifest rejects a document that is not a manifest", async () => {
  const f = stubFetch(() => jsonResponse({ hello: "world" }));
  await assert.rejects(() => fetchManifest("http://studio/x", { fetchImpl: f }), ManifestError);
});

test("fetchManifest refuses a manifest version it cannot read", async () => {
  const f = stubFetch(() => jsonResponse(manifestFixture({ manifest_version: 2 })));
  await assert.rejects(() => fetchManifest("http://studio/x", { fetchImpl: f }), /manifest_version 2/);
});

test("fetchManifest turns a 404 into an instruction, not a stack trace", async () => {
  const f = stubFetch(() => new Response("{}", { status: 404 }));
  await assert.rejects(() => fetchManifest("http://studio/x", { fetchImpl: f }), /GRAVITONE_KEY_ID/);
});

test("fetchManifest reports an unreachable studio as such", async () => {
  const f = stubFetch(() => new Error("ECONNREFUSED"));
  await assert.rejects(() => fetchManifest("http://studio/x", { fetchImpl: f }), /could not reach the studio/);
});

test("config refuses to start without a key, and says which variable", () => {
  assert.throws(() => loadConfig({ GRAVITONE_KEY_ID: "k1" }), ConfigError);
  assert.throws(() => loadConfig({ GRAVITONE_KEY_ID: "k1" }), /GRAVITONE_API_KEY/);
  assert.throws(() => loadConfig({ GRAVITONE_API_KEY: "s" }), /GRAVITONE_KEY_ID/);
});

test("config refuses the placeholder secret rather than 401ing later", () => {
  assert.throws(
    () => loadConfig({ GRAVITONE_API_KEY: "YOUR_GRAVITONE_KEY", GRAVITONE_KEY_ID: "k1" }),
    /placeholder/,
  );
  assert.throws(
    () => loadConfig({ GRAVITONE_API_KEY: "${GRAVITONE_API_KEY}", GRAVITONE_KEY_ID: "k1" }),
    /placeholder/,
  );
});

test("config defaults the studio URL and strips trailing slashes", () => {
  const c = loadConfig({ GRAVITONE_API_KEY: "s", GRAVITONE_KEY_ID: "k 1" });
  assert.equal(c.studioUrl, DEFAULT_STUDIO_URL);
  assert.equal(manifestUrl(c), `${DEFAULT_STUDIO_URL}/api/keys/k%201/manifest`);

  const d = loadConfig({ GRAVITONE_API_KEY: "s", GRAVITONE_KEY_ID: "k1", GRAVITONE_STUDIO_URL: "https://studio.example.com/" });
  assert.equal(manifestUrl(d), "https://studio.example.com/api/keys/k1/manifest");
});
