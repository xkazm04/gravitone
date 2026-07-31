// One tool call → one HTTP request, built from the manifest alone. The wire
// shape IS the contract, so it is asserted directly.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRequest, callTool } from "../lib/call.mjs";
import { jsonResponse, manifestFixture, stubFetch } from "./fixture.mjs";

const CFG = { baseUrl: "https://voice.example.com", apiKey: "gvt_secret" };
const M = manifestFixture();
const speak = M.tools[0];
const listVoices = M.tools[1];
const transcribe = M.tools[2];

test("path params are substituted and encoded; query params land in the query", () => {
  const { url, init } = buildRequest(speak, { voice_id: "alba/x", text: "hi", output_format: "mp3_24000_128" }, CFG);
  assert.equal(url, "https://voice.example.com/v1/text-to-speech/alba%2Fx?output_format=mp3_24000_128");
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body), { text: "hi" }); // NOT the path or query params
});

test("every call presents the key as xi-api-key", () => {
  for (const tool of [speak, listVoices]) {
    const { init } = buildRequest(tool, { voice_id: "alba", text: "hi" }, CFG);
    assert.equal(init.headers["xi-api-key"], "gvt_secret");
  }
});

test("a GET carries no body", () => {
  const { url, init } = buildRequest(listVoices, {}, CFG);
  assert.equal(url, "https://voice.example.com/v1/voices");
  assert.equal(init.body, undefined);
});

test("a missing required parameter fails BEFORE a request is sent", async () => {
  const f = stubFetch(() => jsonResponse({}));
  const res = await callTool(speak, { voice_id: "alba" }, { ...CFG, fetchImpl: f });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /text/);
  assert.equal(f.calls.length, 0);
});

test("a file parameter becomes a multipart upload, not a JSON string", () => {
  const { init } = buildRequest(transcribe, { file: Buffer.from("RIFFwav").toString("base64"), diarize: true }, CFG);
  assert.ok(init.body instanceof FormData);
  assert.ok(init.body.get("file"));
  assert.equal(init.body.get("diarize"), "true");
  // Content-Type is FormData's to set — a hand-written one loses the boundary.
  assert.equal(init.headers["Content-Type"], undefined);
});

test("audio comes back as an MCP audio block with its real mime type", async () => {
  const f = stubFetch(() =>
    new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg", "X-Audio-Seconds": "1.5" },
    }),
  );
  const res = await callTool(speak, { voice_id: "alba", text: "hi" }, { ...CFG, fetchImpl: f });
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].type, "audio");
  assert.equal(res.content[0].mimeType, "audio/mpeg");
  assert.equal(Buffer.from(res.content[0].data, "base64").length, 4);
  assert.match(res.content[1].text, /1.5s of audio/);
});

test("a refusal is an ERROR result carrying the service's own detail", async () => {
  const f = stubFetch(() =>
    new Response(JSON.stringify({ detail: "key does not hold scope 'performance'" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const res = await callTool(speak, { voice_id: "alba", text: "hi" }, { ...CFG, fetchImpl: f });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /does not hold scope/);
  assert.match(res.content[0].text, /scope this endpoint requires/);
});

test("backpressure is reported as backpressure", async () => {
  const f = stubFetch(() => new Response("{}", { status: 429, headers: { "Retry-After": "3" } }));
  const res = await callTool(speak, { voice_id: "alba", text: "hi" }, { ...CFG, fetchImpl: f });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /capacity/);
});

test("an unreachable service is an error, never an empty success", async () => {
  const f = stubFetch(() => new Error("ECONNREFUSED"));
  const res = await callTool(listVoices, {}, { ...CFG, fetchImpl: f });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /could not reach/);
});
