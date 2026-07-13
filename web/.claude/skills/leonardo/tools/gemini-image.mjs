#!/usr/bin/env node
// Minimal Gemini image generator (nano-banana). Fallback when Leonardo/OpenAI
// credits are unavailable. Uses $GEMINI_API_KEY.
//   node gemini-image.mjs generate --prompt "..." --output path.png
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const args = {};
for (let i = 3; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[++i];
}
const key = process.env.GEMINI_API_KEY;
if (!key) { console.error("GEMINI_API_KEY missing"); process.exit(1); }
if (!args.prompt || !args.output) { console.error('need --prompt and --output'); process.exit(1); }

const MODELS = ["gemini-2.5-flash-image", "gemini-2.0-flash-preview-image-generation"];

for (const model of MODELS) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  process.stderr.write(`[gemini-image] ${model} …\n`);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: args.prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
    });
  } catch (e) { process.stderr.write(`  fetch failed: ${e}\n`); continue; }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { process.stderr.write(`  ${res.status}: ${JSON.stringify(body).slice(0, 220)}\n`); continue; }
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img) { process.stderr.write(`  no image in response\n`); continue; }
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, Buffer.from(img.inlineData.data, "base64"));
  process.stdout.write(JSON.stringify({ ok: true, model, output: args.output }) + "\n");
  process.exit(0);
}
console.error(JSON.stringify({ error: "all models failed" }));
process.exit(1);
