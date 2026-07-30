// Tests for the gravitone-build client. Node stdlib only:
//
//   node --test scripts/
//
// The service is mocked at the `fetch` boundary (never stubbed at the client's
// own methods) so the routes, the JSON bodies and the API-key header are part
// of what is asserted -- a client that talks to a mock of itself proves nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseArgs, parseScript, diffAgainstLock, artifactNames, makeClient,
  fetchArtifacts, run, EXIT_OK, EXIT_ERROR, EXIT_DRIFT, DEFAULT_HOST,
} from "./gravitone-build.mjs";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

const SCRIPT = [
  "# a narration script",
  "",
  '{"id": "scene-1", "voice": "alba", "text": "Hello world."}',
  '{"id": "scene-2", "voice": "alba", "text": "Second line.", "format": "mp3_24000_128"}',
].join("\n");

async function scratch() {
  return mkdtemp(path.join(tmpdir(), "gravitone-build-"));
}

/** A mock service. Records every request; answers the three build routes. */
function mockService({ planLines, lockLines, audio = Buffer.from("RIFFdata") } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname;
    calls.push({ route, method: init.method, headers: init.headers,
                 body: init.body ? JSON.parse(init.body) : null });
    const json = (value) => ({
      ok: true, status: 200,
      json: async () => value,
      text: async () => JSON.stringify(value),
      arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.length),
    });
    if (route === "/v1/build/plan") {
      return json({
        lines: planLines, fresh: planLines.filter((l) => l.state === "fresh").length,
        would_render: planLines.filter((l) => l.state !== "fresh").length,
        build_id: "f".repeat(64), identity_version: "gravitone-speech-identity/1",
      });
    }
    if (route === "/v1/build") {
      return json({
        lines: planLines.map((l) => ({ ...l, state: "rendered" })),
        fresh: 0, rendered: planLines.length, build_id: "f".repeat(64),
        identity_version: "gravitone-speech-identity/1",
      });
    }
    if (route === "/v1/build/lock") {
      return json({
        schema_version: "gravitone.lock/1",
        identity_version: "gravitone-speech-identity/1",
        lines: lockLines,
      });
    }
    if (route.startsWith("/v1/audio/")) return json(null);
    return { ok: false, status: 404, text: async () => '{"detail":"nope"}' };
  };
  return { fetchImpl, calls };
}

const PLAN_LINES = [
  { id: "scene-1", digest: DIGEST_A, format: "wav_24000", state: "fresh" },
  { id: "scene-2", digest: DIGEST_B, format: "mp3_24000_128", state: "would_render" },
];
const LOCK_LINES = {
  "scene-1": { digest: DIGEST_A, engine_version: "pocket_tts/1", voice: "alba", format: "wav_24000" },
  "scene-2": { digest: DIGEST_B, engine_version: "pocket_tts/1", voice: "alba", format: "mp3_24000_128" },
};

// --- arguments ---------------------------------------------------------------

test("parseArgs reads the flags and trims the host", () => {
  const opts = parseArgs(["s.jsonl", "--host", "http://box:8080/", "--check",
                          "--lockfile", "a/b.lock", "--fetch", "out"]);
  assert.equal(opts.script, "s.jsonl");
  assert.equal(opts.host, "http://box:8080");
  assert.equal(opts.check, true);
  assert.equal(opts.lockfile, "a/b.lock");
  assert.equal(opts.fetchDir, "out");
});

test("parseArgs defaults to the local service", () => {
  const prior = process.env.GRAVITONE_URL;
  delete process.env.GRAVITONE_URL;
  try {
    assert.equal(parseArgs(["s.jsonl"]).host, DEFAULT_HOST);
  } finally {
    if (prior !== undefined) process.env.GRAVITONE_URL = prior;
  }
});

test("parseArgs refuses what it does not understand", () => {
  assert.throws(() => parseArgs(["s.jsonl", "--nope"]), /unknown option/);
  assert.throws(() => parseArgs(["s.jsonl", "--host"]), /needs a value/);
  assert.throws(() => parseArgs(["a", "b"]), /one script file at a time/);
});

// --- the script file ---------------------------------------------------------

test("parseScript reads JSON Lines and ignores comments and blanks", () => {
  const lines = parseScript(SCRIPT);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { id: "scene-1", voice: "alba", text: "Hello world." });
  assert.equal(lines[1].format, "mp3_24000_128");
});

test("parseScript accepts a generated whole-file array or {lines}", () => {
  const asArray = JSON.stringify([{ id: "a", voice: "alba", text: "One." }]);
  assert.equal(parseScript(asArray)[0].id, "a");
  const asObject = JSON.stringify({ lines: [{ id: "a", voice: "alba", text: "One." }] }, null, 2);
  assert.equal(parseScript(asObject)[0].id, "a");
});

test("parseScript names the line number of a problem", () => {
  assert.throws(() => parseScript('{"id": "a"\n'), /line 1: not valid JSON/);
  assert.throws(() => parseScript('{"id": "a", "voice": "alba"}'), /line 1: missing required string field "text"/);
  assert.throws(() => parseScript('{"id": "a", "voice": "v", "text": "t", "speed": 2}'), /unknown field "speed"/);
  assert.throws(() => parseScript("\n\n"), /no lines/);
});

test("parseScript refuses duplicate ids -- a lockfile is keyed by id", () => {
  const dupes = '{"id": "a", "voice": "v", "text": "One."}\n{"id": "a", "voice": "v", "text": "Two."}';
  assert.throws(() => parseScript(dupes), /line 2: duplicate id "a" \(first seen on line 1\)/);
});

// --- the diff ----------------------------------------------------------------

test("diffAgainstLock separates changed, added and removed", () => {
  const lock = { lines: { "scene-1": { digest: DIGEST_A }, "gone": { digest: DIGEST_A } } };
  const diff = diffAgainstLock([
    { id: "scene-1", digest: DIGEST_A },
    { id: "scene-2", digest: DIGEST_B },
    { id: "scene-3", digest: DIGEST_B },
  ], lock);
  assert.deepEqual(diff.unchanged, ["scene-1"]);
  assert.deepEqual(diff.added, ["scene-2", "scene-3"]);
  assert.deepEqual(diff.removed, ["gone"]);
  assert.equal(diff.drifted, true);
});

test("an unrendered line is not drift -- the store's cache is not the contract", () => {
  const diff = diffAgainstLock(
    [{ id: "scene-1", digest: DIGEST_A, state: "would_render" }],
    { lines: { "scene-1": { digest: DIGEST_A } } });
  assert.equal(diff.drifted, false);
});

test("a moved digest is drift, and the diff says from what to what", () => {
  const diff = diffAgainstLock([{ id: "scene-1", digest: DIGEST_B }],
                               { lines: { "scene-1": { digest: DIGEST_A } } });
  assert.equal(diff.drifted, true);
  assert.deepEqual(diff.changed, [{ id: "scene-1", from: DIGEST_A, to: DIGEST_B }]);
});

test("artifactNames never escape the output directory", () => {
  const names = artifactNames([
    { id: "../../etc/passwd", format: "wav_24000" },
    { id: "scene 1", format: "mp3_24000_128" },
    { id: "scene/1", format: "mp3_24000_128" },
    { id: "...", format: null },
  ]);
  assert.equal(new Set(names).size, 4);
  for (const name of names) {
    assert.ok(!name.includes("/") && !name.includes("\\") && !name.includes(".."), name);
  }
  assert.equal(names[1], "scene_1.mp3");
  assert.equal(names[2], "scene_1-2.mp3");
  assert.ok(names[3].endsWith(".wav"));
});

// --- the client --------------------------------------------------------------

test("the client attaches the key and posts the manifest to the real routes", async () => {
  const { fetchImpl, calls } = mockService({ planLines: PLAN_LINES, lockLines: LOCK_LINES });
  const client = makeClient({ host: "http://box:8080", apiKey: "gvt_secret", fetchImpl });
  await client.plan([{ id: "scene-1", voice: "alba", text: "Hello world." }]);
  assert.equal(calls[0].route, "/v1/build/plan");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["xi-api-key"], "gvt_secret");
  assert.deepEqual(calls[0].body.lines[0].id, "scene-1");
});

test("a service error is reported with its named detail, not a stack", async () => {
  const client = makeClient({
    host: "http://box:8080",
    fetchImpl: async () => ({ ok: false, status: 410, text: async () => '{"detail":"this build\'s audio is no longer stored"}' }),
  });
  await assert.rejects(() => client.plan([]), /410 this build's audio is no longer stored/);
});

test("an unreachable service names the host", async () => {
  const client = makeClient({
    host: "http://nowhere:1",
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  await assert.rejects(() => client.plan([]), /could not be reached at http:\/\/nowhere:1/);
});

// --- end to end --------------------------------------------------------------

async function writeScript(dir) {
  const file = path.join(dir, "script.jsonl");
  await writeFile(file, SCRIPT);
  return file;
}

test("a plan against a matching lockfile is exit 0 and reports no drift", async () => {
  const dir = await scratch();
  const script = await writeScript(dir);
  const lockfile = path.join(dir, "gravitone.lock");
  await writeFile(lockfile, JSON.stringify({ schema_version: "gravitone.lock/1", lines: LOCK_LINES }));
  const { fetchImpl } = mockService({ planLines: PLAN_LINES, lockLines: LOCK_LINES });
  const out = [];
  const code = await run([script, "--lockfile", lockfile, "--check"],
                         { fetchImpl, log: (l) => out.push(l), error: (l) => out.push(l) });
  assert.equal(code, EXIT_OK);
  assert.match(out.join("\n"), /no drift/);
});

test("--check exits 2 when the lockfile does not describe the script", async () => {
  const dir = await scratch();
  const script = await writeScript(dir);
  const lockfile = path.join(dir, "gravitone.lock");
  await writeFile(lockfile, JSON.stringify({
    lines: { ...LOCK_LINES, "scene-2": { ...LOCK_LINES["scene-2"], digest: `sha256:${"c".repeat(64)}` } },
  }));
  const { fetchImpl } = mockService({ planLines: PLAN_LINES, lockLines: LOCK_LINES });
  const out = [];
  const code = await run([script, "--lockfile", lockfile, "--check"],
                         { fetchImpl, log: (l) => out.push(l), error: (l) => out.push(l) });
  assert.equal(code, EXIT_DRIFT);
  const text = out.join("\n");
  assert.match(text, /DRIFT/);
  assert.match(text, /~ scene-2/);
});

test("--check without a lockfile is a usage error, not a silent pass", async () => {
  const dir = await scratch();
  const script = await writeScript(dir);
  const { fetchImpl } = mockService({ planLines: PLAN_LINES, lockLines: LOCK_LINES });
  const out = [];
  const code = await run([script, "--lockfile", path.join(dir, "absent.lock"), "--check"],
                         { fetchImpl, log: () => {}, error: (l) => out.push(l) });
  assert.equal(code, EXIT_ERROR);
  assert.match(out.join("\n"), /--check needs a lockfile/);
});

test("--lock writes a stable, sorted, newline-terminated lockfile", async () => {
  const dir = await scratch();
  const script = await writeScript(dir);
  const lockfile = path.join(dir, "gravitone.lock");
  const { fetchImpl, calls } = mockService({ planLines: PLAN_LINES, lockLines: LOCK_LINES });
  const code = await run([script, "--lockfile", lockfile, "--lock"],
                         { fetchImpl, log: () => {}, error: () => {} });
  assert.equal(code, EXIT_OK);
  assert.ok(calls.some((c) => c.route === "/v1/build/lock"));
  const written = await readFile(lockfile, "utf8");
  assert.ok(written.endsWith("\n"));
  const doc = JSON.parse(written);
  assert.equal(doc.schema_version, "gravitone.lock/1");
  assert.deepEqual(Object.keys(doc.lines), ["scene-1", "scene-2"]);
});

test("--fetch renders then downloads, and a second run downloads nothing", async () => {
  const dir = await scratch();
  const script = await writeScript(dir);
  const outDir = path.join(dir, "audio");
  const { fetchImpl, calls } = mockService({ planLines: PLAN_LINES, lockLines: LOCK_LINES });
  const code = await run([script, "--lockfile", path.join(dir, "g.lock"), "--fetch", outDir],
                         { fetchImpl, log: () => {}, error: () => {} });
  assert.equal(code, EXIT_OK);
  assert.ok(calls.some((c) => c.route === "/v1/build" && c.method === "POST"));
  assert.equal(calls.filter((c) => c.route.startsWith("/v1/audio/")).length, 2);
  assert.equal((await readFile(path.join(outDir, "scene-1.wav"))).toString(), "RIFFdata");
  const sidecar = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));
  assert.equal(sidecar.lines["scene-1"].digest, DIGEST_A);

  const again = mockService({ planLines: PLAN_LINES, lockLines: LOCK_LINES });
  await run([script, "--lockfile", path.join(dir, "g.lock"), "--fetch", outDir],
            { fetchImpl: again.fetchImpl, log: () => {}, error: () => {} });
  assert.equal(again.calls.filter((c) => c.route.startsWith("/v1/audio/")).length, 0,
               "an unchanged artifact is not downloaded twice");
});

test("--fetch re-downloads a line whose digest moved", async () => {
  const dir = await scratch();
  const outDir = path.join(dir, "audio");
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "scene-1.wav"), "stale");
  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify({
    lines: { "scene-1": { digest: `sha256:${"9".repeat(64)}`, file: "scene-1.wav" } },
  }));
  const { fetchImpl, calls } = mockService({ planLines: PLAN_LINES, lockLines: LOCK_LINES });
  const client = makeClient({ host: "http://box:8080", fetchImpl });
  const result = await fetchArtifacts(client, PLAN_LINES, outDir, () => {});
  assert.equal(result.downloaded, 2);
  assert.equal(result.skipped, 0);
  assert.equal(calls.filter((c) => c.route.startsWith("/v1/audio/")).length, 2);
});

test("--json prints a machine report and never the key", async () => {
  const dir = await scratch();
  const script = await writeScript(dir);
  const prior = process.env.GRAVITONE_API_KEY;
  process.env.GRAVITONE_API_KEY = "gvt_do_not_print";
  const out = [];
  try {
    const { fetchImpl } = mockService({ planLines: PLAN_LINES, lockLines: LOCK_LINES });
    const code = await run([script, "--lockfile", path.join(dir, "g.lock"), "--json"],
                           { fetchImpl, log: (l) => out.push(l), error: (l) => out.push(l) });
    assert.equal(code, EXIT_OK);
  } finally {
    if (prior === undefined) delete process.env.GRAVITONE_API_KEY;
    else process.env.GRAVITONE_API_KEY = prior;
  }
  const text = out.join("\n");
  assert.ok(!text.includes("gvt_do_not_print"));
  const report = JSON.parse(text);
  assert.equal(report.would_render, 1);
  assert.equal(report.drifted, true, "no lockfile on disk means every line is new");
});

test("an unreadable script file is exit 1 with a named reason", async () => {
  const out = [];
  const code = await run(["no-such-script.jsonl"], { log: () => {}, error: (l) => out.push(l) });
  assert.equal(code, EXIT_ERROR);
  assert.match(out.join("\n"), /no-such-script.jsonl/);
});

test("no script file prints usage and exits 1", async () => {
  const out = [];
  assert.equal(await run([], { log: (l) => out.push(l), error: (l) => out.push(l) }), EXIT_ERROR);
  assert.match(out.join("\n"), /usage:/);
});
