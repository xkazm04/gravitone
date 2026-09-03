#!/usr/bin/env node
// gravitone-build -- speech as a build artifact, from the command line.
//
// The service already answers the two questions a build system asks: "what
// would change?" (POST /v1/build/plan) and "what is the name of each line?"
// (POST /v1/build/lock). This script is the thin, dependency-free client that
// turns those answers into the three things a repository actually needs:
//
//   * a human diff, so a reviewer can see which lines of narration moved;
//   * `--check`, which exits 2 when the audio drifts from the committed
//     gravitone.lock -- the CI primitive, and the whole point of the lockfile;
//   * `--lock` / `--fetch`, which write the lockfile and pull the artifacts.
//
// Node stdlib only (fetch, node:fs, node:path). No install step, no lockfile of
// its own, nothing to audit.
//
//   node scripts/gravitone-build.mjs script.jsonl                 # plan + diff
//   node scripts/gravitone-build.mjs script.jsonl --check         # CI gate
//   node scripts/gravitone-build.mjs script.jsonl --lock          # write lock
//   node scripts/gravitone-build.mjs script.jsonl --fetch ./audio # render+pull
//
// Options:
//   --host URL        service base URL (env GRAVITONE_URL, default
//                     http://127.0.0.1:8080)
//   --lockfile PATH   the lockfile to read and write (default ./gravitone.lock)
//   --lock            write the lockfile from POST /v1/build/lock
//   --check           compare the plan against the lockfile; exit 2 on drift
//   --fetch DIR       POST /v1/build (renders what is missing), then download
//                     each line's artifact into DIR via GET /v1/audio/{digest}
//   --json            print the machine-readable report instead of the diff
//   --timeout MS      per-request timeout (default 120000)
//
// The API key is read from GRAVITONE_API_KEY (or TTS_API_KEY) and is never
// printed back, not even in --json output.
//
// EXIT CODES -- a pipeline reads these, not the prose:
//   0  no drift (or the requested write succeeded)
//   1  usage error, unreadable script, or the service could not be reached
//   2  --check found drift: the audio this script would produce is not the
//      audio gravitone.lock names
//
// SCRIPT FILE FORMAT -- JSON Lines, one line per line of speech:
//
//   # comments and blank lines are ignored
//   {"id": "scene-1", "voice": "alba", "text": "Hello world."}
//   {"id": "scene-2", "voice": "sarah", "text": "Who's there?", "emotion": "curious"}
//   {"id": "credits", "voice": "alba", "text": "The end.", "format": "mp3_24000_128"}
//
// Per-line fields: `id` and `voice` and `text` are required; `emotion`,
// `format`, `settings` and `frames_after_eos` are optional and are passed
// through to the manifest verbatim. A whole-file JSON array, or an object with
// a `lines` array, is accepted too -- some teams generate the script rather
// than write it. `id` must be unique: the lockfile is keyed by it.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_HOST = "http://127.0.0.1:8080";
export const DEFAULT_LOCKFILE = "gravitone.lock";
export const DEFAULT_TIMEOUT_MS = 120000;
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_DRIFT = 2;

/** Fields a manifest line may carry. Anything else in the script is a typo, and
 *  a typo that changes nothing is worse than one that is refused. */
const LINE_FIELDS = new Set([
  "id", "voice", "text", "emotion", "format", "settings", "frames_after_eos",
]);
const REQUIRED_FIELDS = ["id", "voice", "text"];

// --- argument parsing --------------------------------------------------------

export function parseArgs(argv) {
  const opts = {
    script: null,
    host: process.env.GRAVITONE_URL || DEFAULT_HOST,
    lockfile: DEFAULT_LOCKFILE,
    lock: false,
    check: false,
    fetchDir: null,
    json: false,
    timeout: DEFAULT_TIMEOUT_MS,
  };
  const rest = [...argv];
  while (rest.length) {
    const arg = rest.shift();
    const take = (name) => {
      const value = rest.shift();
      if (value === undefined) throw new Error(`${name} needs a value`);
      return value;
    };
    if (arg === "--host") opts.host = take("--host");
    else if (arg === "--lockfile") opts.lockfile = take("--lockfile");
    else if (arg === "--fetch") opts.fetchDir = take("--fetch");
    else if (arg === "--timeout") {
      const ms = Number(take("--timeout"));
      if (!Number.isFinite(ms) || ms <= 0) throw new Error("--timeout must be a positive number of milliseconds");
      opts.timeout = ms;
    } else if (arg === "--lock") opts.lock = true;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else if (opts.script === null) opts.script = arg;
    else throw new Error(`unexpected argument ${arg} (one script file at a time)`);
  }
  opts.host = String(opts.host).replace(/\/+$/, "");
  return opts;
}

// --- the script file ---------------------------------------------------------

/** Parse a script file into manifest lines. Throws a message a human can act
 *  on, naming the offending line NUMBER -- a stack trace is not a diagnosis. */
export function parseScript(text) {
  const trimmed = text.trim();
  let raw = null;
  if (trimmed.startsWith("[") || (trimmed.startsWith("{") && trimmed.includes("\n") && trimmed.endsWith("}") && trimmed.includes('"lines"'))) {
    let whole;
    try {
      whole = JSON.parse(trimmed);
    } catch (err) {
      whole = null;
    }
    if (Array.isArray(whole)) raw = whole.map((value, i) => [i + 1, value]);
    else if (whole && Array.isArray(whole.lines)) raw = whole.lines.map((value, i) => [i + 1, value]);
  }
  if (raw === null) {
    raw = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch (err) {
        throw new Error(`line ${i + 1}: not valid JSON (${err.message})`);
      }
      raw.push([i + 1, value]);
    }
  }

  const out = [];
  const seen = new Map();
  for (const [lineNo, value] of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`line ${lineNo}: expected a JSON object`);
    }
    for (const field of REQUIRED_FIELDS) {
      if (typeof value[field] !== "string" || !value[field]) {
        throw new Error(`line ${lineNo}: missing required string field "${field}"`);
      }
    }
    for (const key of Object.keys(value)) {
      if (!LINE_FIELDS.has(key)) {
        throw new Error(`line ${lineNo}: unknown field "${key}" (allowed: ${[...LINE_FIELDS].join(", ")})`);
      }
    }
    if (seen.has(value.id)) {
      throw new Error(`line ${lineNo}: duplicate id "${value.id}" (first seen on line ${seen.get(value.id)}); a lockfile is keyed by id`);
    }
    seen.set(value.id, lineNo);
    out.push(value);
  }
  if (!out.length) throw new Error("the script file has no lines");
  return out;
}

// --- the service -------------------------------------------------------------

export function makeClient({ host, apiKey, timeout = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const readHeaders = apiKey ? { "xi-api-key": apiKey } : {};
  const writeHeaders = { ...readHeaders, "Content-Type": "application/json" };

  async function call(method, route, body) {
    const url = `${host}${route}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: body === undefined ? readHeaders : writeHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new Error(`${method} ${route}: the service could not be reached at ${host} (${err.message})`);
    }
    if (!response.ok) {
      let detail = "";
      try {
        const text = await response.text();
        try {
          detail = JSON.parse(text).detail || text;
        } catch (err) {
          detail = text;
        }
      } catch (err) {
        detail = "";
      }
      throw new Error(`${method} ${route}: ${response.status} ${String(detail).slice(0, 500)}`);
    }
    return response;
  }

  return {
    async plan(lines) {
      return (await call("POST", "/v1/build/plan", { lines })).json();
    },
    async build(lines) {
      return (await call("POST", "/v1/build", { lines })).json();
    },
    async lock(lines) {
      return (await call("POST", "/v1/build/lock", { lines })).json();
    },
    async audio(digest) {
      const response = await call("GET", `/v1/audio/${digest}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

// --- the diff ----------------------------------------------------------------

/** What moved between the plan and the committed lockfile.
 *
 *  `changed` is the honest headline: those lines are named by the lockfile and
 *  the service now computes a DIFFERENT digest for them, which means the audio
 *  in the repository is not the audio this script describes. `added`/`removed`
 *  are the script growing and shrinking; `rendered` is the store's cache state
 *  and is deliberately NOT drift (a line can be absent from the store and still
 *  be exactly what the lockfile promised). */
export function diffAgainstLock(planLines, lock) {
  const locked = (lock && lock.lines) || {};
  const changed = [];
  const added = [];
  const unchanged = [];
  for (const line of planLines) {
    const entry = locked[line.id];
    if (!entry) added.push(line.id);
    else if (entry.digest !== line.digest) changed.push({ id: line.id, from: entry.digest, to: line.digest });
    else unchanged.push(line.id);
  }
  const planIds = new Set(planLines.map((line) => line.id));
  const removed = Object.keys(locked).filter((id) => !planIds.has(id)).sort();
  return {
    changed, added, removed, unchanged,
    drifted: changed.length + added.length + removed.length > 0,
  };
}

const short = (digest) => String(digest).replace(/^sha256:/, "").slice(0, 12);

export function formatDiff(plan, diff, { lockfile, hasLock }) {
  const out = [];
  const total = plan.lines.length;
  out.push(`gravitone build plan: ${total} line${total === 1 ? "" : "s"}, ` +
           `${plan.fresh} already rendered, ${plan.would_render} to render`);
  out.push(`  identity ${plan.identity_version}   build ${short(plan.build_id || "")}`);
  if (!hasLock) {
    out.push(`  no ${lockfile} yet -- run with --lock to write one`);
  } else if (!diff.drifted) {
    out.push(`  no drift against ${lockfile}`);
  } else {
    out.push(`  DRIFT against ${lockfile}:`);
    for (const item of diff.changed) {
      out.push(`    ~ ${item.id}  ${short(item.from)} -> ${short(item.to)}`);
    }
    for (const id of diff.added) out.push(`    + ${id}  (not in the lockfile)`);
    for (const id of diff.removed) out.push(`    - ${id}  (in the lockfile, not in the script)`);
  }
  const toRender = plan.lines.filter((line) => line.state === "would_render");
  if (toRender.length) {
    out.push(`  would render: ${toRender.map((line) => line.id).join(", ")}`);
  }
  return out.join("\n");
}

// --- artifacts ---------------------------------------------------------------

const UNSAFE = /[^A-Za-z0-9._-]+/g;

/** The on-disk name for a line's audio. Mirrors the zip member naming in
 *  service/buildstore.py: sanitized id, extension from the format, and a
 *  numbered suffix on collision -- so a line id can never write outside the
 *  output directory. */
export function artifactNames(lines) {
  const taken = new Set();
  return lines.map((line, index) => {
    let stem = String(line.id).replace(UNSAFE, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 80);
    if (!stem) stem = `line-${index}`;
    const ext = String(line.format || "wav").split("_")[0].replace(UNSAFE, "") || "bin";
    let name = `${stem}.${ext}`;
    if (taken.has(name)) {
      let suffix = 2;
      while (taken.has(`${stem}-${suffix}.${ext}`)) suffix += 1;
      name = `${stem}-${suffix}.${ext}`;
    }
    taken.add(name);
    return name;
  });
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    return null;
  }
}

/** Download every line's artifact into `dir`, skipping the ones already there
 *  under the same digest. The sidecar manifest is what makes "already there"
 *  knowable: a file name says nothing about which version of the line it holds. */
export async function fetchArtifacts(client, lines, dir, log) {
  await mkdir(dir, { recursive: true });
  const sidecarPath = path.join(dir, "manifest.json");
  const previous = (await readJson(sidecarPath)) || { lines: {} };
  const names = artifactNames(lines);
  const manifest = { schema_version: "gravitone.artifacts/1", lines: {} };
  let downloaded = 0;
  let skipped = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const file = names[i];
    const prior = previous.lines[line.id];
    const onDisk = existsSync(path.join(dir, file));
    if (prior && prior.digest === line.digest && prior.file === file && onDisk) {
      manifest.lines[line.id] = prior;
      skipped += 1;
      continue;
    }
    const bytes = await client.audio(line.digest);
    await writeFile(path.join(dir, file), bytes);
    manifest.lines[line.id] = { digest: line.digest, file, bytes: bytes.length };
    downloaded += 1;
    log(`  fetched ${file}  ${short(line.digest)}  ${bytes.length} bytes`);
  }
  const ordered = { ...manifest, lines: Object.fromEntries(Object.keys(manifest.lines).sort().map((id) => [id, manifest.lines[id]])) };
  await writeFile(sidecarPath, `${JSON.stringify(ordered, null, 2)}\n`);
  return { downloaded, skipped, dir };
}

// --- the run -----------------------------------------------------------------

export async function run(argv, io = {}) {
  const log = io.log || ((line) => process.stdout.write(`${line}\n`));
  const errorLog = io.error || ((line) => process.stderr.write(`${line}\n`));
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    errorLog(`gravitone-build: ${err.message}`);
    return EXIT_ERROR;
  }
  if (opts.help || !opts.script) {
    log("usage: node scripts/gravitone-build.mjs <script.jsonl> [--host URL] [--lockfile PATH] [--lock] [--check] [--fetch DIR] [--json]");
    log("       the script file is JSON Lines: {\"id\":..., \"voice\":..., \"text\":...} per line.");
    return opts.help ? EXIT_OK : EXIT_ERROR;
  }

  let lines;
  try {
    lines = parseScript(await readFile(opts.script, "utf8"));
  } catch (err) {
    errorLog(`gravitone-build: ${opts.script}: ${err.message}`);
    return EXIT_ERROR;
  }

  const client = io.client || makeClient({
    host: opts.host,
    apiKey: process.env.GRAVITONE_API_KEY || process.env.TTS_API_KEY || "",
    timeout: opts.timeout,
    fetchImpl: io.fetchImpl,
  });

  const existing = await readJson(opts.lockfile);
  let plan;
  try {
    plan = await client.plan(lines);
  } catch (err) {
    errorLog(`gravitone-build: ${err.message}`);
    return EXIT_ERROR;
  }
  const diff = diffAgainstLock(plan.lines, existing);

  const report = {
    script: opts.script,
    lockfile: opts.lockfile,
    build_id: plan.build_id,
    identity_version: plan.identity_version,
    fresh: plan.fresh,
    would_render: plan.would_render,
    drift: { changed: diff.changed, added: diff.added, removed: diff.removed },
    drifted: diff.drifted,
  };

  if (!opts.json) {
    log(formatDiff(plan, diff, { lockfile: opts.lockfile, hasLock: Boolean(existing) }));
  }

  try {
    if (opts.fetchDir) {
      const built = await client.build(lines);
      const byId = new Map(built.lines.map((line) => [line.id, line]));
      const ordered = plan.lines.map((line) => byId.get(line.id) || line);
      if (!opts.json) log(`  rendered ${built.rendered}, already stored ${built.fresh}`);
      report.build_id = built.build_id;
      report.fetched = await fetchArtifacts(client, ordered, opts.fetchDir,
                                            opts.json ? () => {} : log);
    }
    if (opts.lock) {
      const doc = await client.lock(lines);
      await writeFile(opts.lockfile, `${JSON.stringify(doc, null, 2)}\n`);
      if (!opts.json) log(`  wrote ${opts.lockfile} (${Object.keys(doc.lines).length} lines)`);
      report.wrote_lockfile = opts.lockfile;
    }
  } catch (err) {
    errorLog(`gravitone-build: ${err.message}`);
    return EXIT_ERROR;
  }

  if (opts.json) log(JSON.stringify(report, null, 2));

  if (opts.check && !opts.lock) {
    if (!existing) {
      errorLog(`gravitone-build: --check needs a lockfile; ${opts.lockfile} does not exist (run with --lock and commit it)`);
      return EXIT_ERROR;
    }
    if (diff.drifted) {
      errorLog("gravitone-build: audio drift -- the lockfile does not describe this script");
      return EXIT_DRIFT;
    }
  }
  return EXIT_OK;
}

const invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2));
}
