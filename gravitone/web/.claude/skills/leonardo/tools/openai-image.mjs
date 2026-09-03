#!/usr/bin/env node

/**
 * OpenAI Image Tool — generate / edit images with gpt-image-2.
 *
 * gpt-image-2 (snapshot gpt-image-2-2026-04-21) is OpenAI's agentic image model:
 * it reasons about structure (and can web-search) before rendering, and returns
 * 2K-capable PNGs as base64. It runs through the standard Images API, so unlike
 * the Leonardo flow there is NO polling job — the call returns the image inline.
 *
 * Commands:
 *   generate --prompt "..." --output path.png
 *            [--size 1024x1024|1536x1024|1024x1536|auto] [--quality low|medium|high|auto]
 *            [--n 1] [--background transparent|opaque|auto]
 *   edit     --prompt "..." --image in.png [--image in2.png ...] --output path.png
 *            [--size ...] [--quality ...]
 *
 * Requires OPENAI_API_KEY. Model id is researched/current: `gpt-image-2`.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, resolve, basename } from "path";

const API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
// Current OpenAI image model (researched June 2026): gpt-image-2, snapshot
// gpt-image-2-2026-04-21. Override with OPENAI_IMAGE_MODEL if a newer snapshot ships.
const MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";

function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        // allow repeated --image
        if (args[key] !== undefined) {
          args[key] = Array.isArray(args[key]) ? [...args[key], next] : [args[key], next];
        } else {
          args[key] = next;
        }
        i++;
      } else {
        args[key] = true;
      }
    } else {
      positional.push(argv[i]);
    }
  }
  return { command: positional[0], args };
}

function fail(obj) {
  console.error(JSON.stringify(obj, null, 2));
  process.exit(1);
}

function writeImage(b64, outputPath) {
  const buf = Buffer.from(b64, "base64");
  const absPath = resolve(outputPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, buf);
  return { absPath, bytes: buf.length };
}

async function generate(args) {
  if (!API_KEY) {
    fail({
      error: "OPENAI_API_KEY not set",
      hint: "Add OPENAI_API_KEY to .env (or export it) to generate with gpt-image-2. " +
        "Get a key at https://platform.openai.com/api-keys. Until then, the Leonardo " +
        "backend (leonardo-image.mjs) is the working fallback.",
      model: MODEL,
    });
  }
  if (!args.prompt || !args.output) {
    fail({ error: "Usage: openai-image.mjs generate --prompt \"...\" --output path.png [--size 1024x1024] [--quality high]" });
  }
  const body = {
    model: MODEL,
    prompt: args.prompt,
    n: parseInt(args.n || "1", 10),
    size: args.size || "1024x1024",
    quality: args.quality || "high",
  };
  if (args.background) body.background = args.background; // transparent|opaque|auto

  process.stderr.write(`[openai] ${MODEL} generate ${body.size} quality=${body.quality}\n`);
  const res = await fetch(`${BASE_URL}/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    fail({ error: `OpenAI API ${res.status}`, details: t.slice(0, 800), model: MODEL });
  }
  const data = await res.json();
  const items = data.data || [];
  if (items.length === 0) fail({ error: "No image returned", response: data });

  const outputs = [];
  items.forEach((item, i) => {
    const b64 = item.b64_json;
    if (!b64) return;
    const out = items.length > 1
      ? args.output.replace(/(\.\w+)?$/, `-${i + 1}$1`)
      : args.output;
    const { absPath, bytes } = writeImage(b64, out);
    outputs.push({ output: absPath, bytes });
  });

  console.log(JSON.stringify({ success: true, model: MODEL, usage: data.usage, outputs }, null, 2));
}

async function edit(args) {
  if (!API_KEY) fail({ error: "OPENAI_API_KEY not set", model: MODEL });
  if (!args.prompt || !args.image || !args.output) {
    fail({ error: "Usage: openai-image.mjs edit --prompt \"...\" --image in.png [--image in2.png] --output path.png" });
  }
  const images = Array.isArray(args.image) ? args.image : [args.image];
  const form = new FormData();
  form.append("model", MODEL);
  form.append("prompt", args.prompt);
  form.append("size", args.size || "1024x1024");
  form.append("quality", args.quality || "high");
  for (const p of images) {
    const buf = readFileSync(resolve(p));
    form.append("image[]", new Blob([buf], { type: "image/png" }), basename(p));
  }

  process.stderr.write(`[openai] ${MODEL} edit (${images.length} input image(s))\n`);
  const res = await fetch(`${BASE_URL}/images/edits`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const t = await res.text();
    fail({ error: `OpenAI API ${res.status}`, details: t.slice(0, 800), model: MODEL });
  }
  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) fail({ error: "No image returned", response: data });
  const { absPath, bytes } = writeImage(b64, args.output);
  console.log(JSON.stringify({ success: true, model: MODEL, usage: data.usage, output: absPath, bytes }, null, 2));
}

const { command, args } = parseArgs(process.argv);
switch (command) {
  case "generate":
    generate(args);
    break;
  case "edit":
    edit(args);
    break;
  default:
    console.error(`Unknown command: ${command || "(none)"}\nCommands: generate, edit`);
    process.exit(1);
}
