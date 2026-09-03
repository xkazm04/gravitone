#!/usr/bin/env node

/**
 * gpt-image-2 via the Leonardo platform (v2 generations).
 *
 * Leonardo hosts OpenAI's gpt-image-2 under its own v2 API, so it runs on a
 * LEONARDO_API_KEY (no OpenAI key needed). Endpoint + body per Leonardo docs:
 *   POST https://cloud.leonardo.ai/api/rest/v2/generations
 *   { model: "gpt-image-2", prompt, quality: LOW|MEDIUM|HIGH, width, height,
 *     quantity, prompt_enhance: ON|OFF, public }
 * width/height must be multiples of 16, max edge < 3840, aspect ≤ 3:1.
 *
 * The v2 response/poll shape isn't fully documented, so this submits, logs the
 * raw response, then polls + extracts image URLs defensively (works whether the
 * result comes back inline or via a generation id to poll).
 *
 * Usage:
 *   node leonardo-gpt-image.mjs generate --prompt "..." --output path.png \
 *     [--width 1024] [--height 1024] [--quality MEDIUM] [--quantity 1] [--enhance OFF]
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

const API_KEY = process.env.LEONARDO_API_KEY;
const BASE = "https://cloud.leonardo.ai/api/rest";
const MODEL = "gpt-image-2";
const POLL_INTERVAL_MS = 4000;
const MAX_POLL = 75;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = {};
  const pos = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const n = argv[i + 1];
      if (n && !n.startsWith("--")) { args[k] = n; i++; } else { args[k] = true; }
    } else pos.push(argv[i]);
  }
  return { command: pos[0], args };
}
function fail(o) { console.error(JSON.stringify(o, null, 2)); process.exit(1); }

// Recursively pull image-looking URLs out of an arbitrary response object.
function collectImageUrls(obj, out = []) {
  if (obj == null) return out;
  if (typeof obj === "string") {
    if (/^https?:\/\/\S+\.(png|jpg|jpeg|webp)(\?|$)/i.test(obj) || /cdn\.leonardo|amazonaws/i.test(obj) && /\.(png|jpg|jpeg|webp)/i.test(obj)) {
      out.push(obj);
    }
    return out;
  }
  if (Array.isArray(obj)) { for (const v of obj) collectImageUrls(v, out); return out; }
  if (typeof obj === "object") { for (const v of Object.values(obj)) collectImageUrls(v, out); }
  return out;
}
// Find a generation id anywhere in a submit response.
function findGenerationId(obj) {
  const keys = ["generationId", "id"];
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (cur && typeof cur === "object") {
      for (const [k, v] of Object.entries(cur)) {
        if (keys.includes(k) && typeof v === "string" && v.length >= 8) return v;
        if (v && typeof v === "object") stack.push(v);
      }
    }
  }
  return null;
}
function statusOf(obj) {
  let found = null;
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (cur && typeof cur === "object") {
      for (const [k, v] of Object.entries(cur)) {
        if (k.toLowerCase() === "status" && typeof v === "string") found = v;
        if (v && typeof v === "object") stack.push(v);
      }
    }
  }
  return found;
}

async function api(method, path, body) {
  const opts = { method, headers: { accept: "application/json", authorization: `Bearer ${API_KEY}` } };
  if (body) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { ok: res.ok, status: res.status, text, json };
}

async function generate(args) {
  if (!API_KEY) fail({ error: "LEONARDO_API_KEY not set" });
  if (!args.prompt || !args.output) fail({ error: 'Usage: generate --prompt "..." --output path.png' });

  // Leonardo v2 nests generation params under `parameters`; only `model` and
  // `public` are top-level (a strict validator rejects anything else at root).
  const body = {
    public: false,
    model: MODEL,
    parameters: {
      prompt: args.prompt,
      width: parseInt(args.width || "1024", 10),
      height: parseInt(args.height || "1024", 10),
      quantity: parseInt(args.quantity || "1", 10),
      quality: (args.quality || "MEDIUM").toUpperCase(),
      prompt_enhance: (args.enhance || "OFF").toUpperCase(),
    },
  };
  const P = body.parameters;
  process.stderr.write(`[gpt-image-2@leonardo] submit ${P.width}x${P.height} q=${P.quality} n=${P.quantity}\n`);

  const submit = await api("POST", "/v2/generations", body);
  process.stderr.write(`[gpt-image-2@leonardo] submit status=${submit.status} body=${submit.text.slice(0, 600)}\n`);
  if (!submit.ok) fail({ error: `Leonardo v2 ${submit.status}`, details: submit.text.slice(0, 800) });

  // Maybe the result is already inline.
  let urls = collectImageUrls(submit.json);
  const genId = findGenerationId(submit.json);

  if (urls.length === 0 && genId) {
    process.stderr.write(`[gpt-image-2@leonardo] polling generationId=${genId}\n`);
    for (let i = 0; i < MAX_POLL; i++) {
      await sleep(POLL_INTERVAL_MS);
      // Retrieval is the v1 generation-by-id endpoint (shared store; the v2
      // create endpoint has no GET-by-id). Falls back to v2 in case that changes.
      let g = await api("GET", `/v1/generations/${genId}`);
      if (!g.ok || !g.json) g = await api("GET", `/v2/generations/${genId}`);
      const st = statusOf(g.json) || "";
      urls = collectImageUrls(g.json);
      process.stderr.write(`[gpt-image-2@leonardo] poll ${i + 1}/${MAX_POLL} status=${st} urls=${urls.length}\n`);
      if (/fail/i.test(st)) fail({ error: "generation failed", generationId: genId, body: g.text.slice(0, 600) });
      if (urls.length > 0 && (/complete|finish|success/i.test(st) || urls.length >= P.quantity)) break;
    }
  }

  if (urls.length === 0) fail({ error: "No image URLs found", generationId: genId, hint: "inspect the logged submit/poll bodies above" });

  const outputs = [];
  for (let i = 0; i < urls.length; i++) {
    const imgRes = await fetch(urls[i]);
    if (!imgRes.ok) continue;
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const out = urls.length > 1 ? args.output.replace(/(\.\w+)?$/, `-${i + 1}$1`) : args.output;
    const abs = resolve(out);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
    outputs.push({ output: abs, bytes: buf.length, url: urls[i] });
  }

  // Cloud cleanup — delete the generation from Leonardo unless --no-cleanup.
  // gpt-image-2 gens accumulate in the account otherwise (this tool previously
  // never cleaned up, unlike leonardo-image.mjs). Best-effort.
  let cleaned = false;
  if (genId && !args["no-cleanup"]) {
    const del = await api("DELETE", `/v1/generations/${genId}`);
    cleaned = del.ok;
    process.stderr.write(`[gpt-image-2@leonardo] cloud cleanup ${del.ok ? "ok" : `failed(${del.status})`}\n`);
  }
  console.log(JSON.stringify({ success: true, model: MODEL, generationId: genId, cleaned, outputs }, null, 2));
}

const { command, args } = parseArgs(process.argv);
if (command === "generate") generate(args);
else { console.error("Commands: generate"); process.exit(1); }
