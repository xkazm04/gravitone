#!/usr/bin/env node
// prove-keys — the headless twin of the studio's Proving Ledger.
//
// The keys page can prove a key at the one moment it holds the secret. A deploy
// pipeline holds secrets all the time and has no browser, so the same matrix
// runs here: same probes, same verdicts, same meaning, as JSON on stdout.
//
//   node scripts/prove-keys.mjs --url http://host:8080 --key gvt_… --scopes tts,voices
//   node scripts/prove-keys.mjs --url http://host:8080          # posture only
//
// Exit codes (a pipeline reads these, not the prose):
//   0  nothing alarming — every granted scope served, every ungranted refused
//   1  at least one REFUSED-SCOPE-SERVED row, OR the deployment is OPEN. Both
//      mean this box serves callers it should refuse; both must fail a deploy.
//   2  the deployment could not be reached — nothing was proved either way
//   3  usage error
//
// Env fallbacks: GRAVITONE_URL, GRAVITONE_PROBE_KEY, GRAVITONE_PROBE_SCOPES.
// The key is read from a flag or the environment and never printed back.
//
// KEEP IN SYNC with web/app/keys/_variants/probes.ts — the table below is the
// same plan, and probes.test.ts imports this file to assert they have not
// drifted. Two proofs that disagree are worse than one.

import { pathToFileURL } from "node:url";

/** scope -> the request that proves the deployment ADMITS this scope. A probe
 *  measures the auth boundary only: 401/403 is a refusal, anything else (200,
 *  404, 422) means the request got past it. That is why most of these are reads
 *  or deliberately empty bodies — they cost the box nothing and mutate nothing.
 *  `tts` is the single exception: one word of real synthesis. */
export const PROBES = [
  { scope: "tts", method: "POST", path: "/v1/text-to-speech/{voice}?output_format=wav_24000", body: { text: "one" }, synthesizes: true },
  { scope: "voices", method: "PATCH", path: "/v1/voices/gravitone-probe-no-such-voice", body: {} },
  { scope: "clone", method: "GET", path: "/v1/ingest/modes", body: null },
  { scope: "performance", method: "POST", path: "/v1/performance", body: {} },
  { scope: "stt", method: "POST", path: "/v1/speech-to-text", body: {} },
  { scope: "convai", method: "GET", path: "/v1/convai/agents", body: null },
];

export const POSTURE_PROBE = { method: "GET", path: "/v1/voices" };
export const DEFAULT_PROBE_VOICE = "alba";

export function observedFrom(status) {
  if (status === null) return "unreachable";
  return status === 401 || status === 403 ? "refused" : "allowed";
}

export function verdictFor(expected, observed) {
  if (observed === "unreachable") return "unreachable";
  if (expected === "allowed") return observed === "allowed" ? "proven" : "granted-but-refused";
  return observed === "allowed" ? "REFUSED-SCOPE-SERVED" : "correctly-refused";
}

export function postureFrom(status) {
  if (status === null) return "unreachable";
  return status === 401 || status === 403 ? "enforced" : "open";
}

/** service/auth.py answers 401 for "no key" and for "valid key, wrong scope"
 *  alike, so a refusal on its own cannot tell them apart. Only a served
 *  positive probe in the same run proves the key is recognised — without one,
 *  the refusals below prove the key is unknown, not that scoping works. */
export function negativesAreConclusive(probes) {
  return probes.some((p) => p.expected === "allowed" && p.verdict === "proven");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else out[a.slice(2)] = argv[i + 1]?.startsWith("--") ? "" : (argv[++i] ?? "");
  }
  return out;
}

async function probeStatus(base, path, { method, body, secret, timeoutMs }) {
  const headers = {};
  if (secret) headers["xi-api-key"] = secret;
  if (body !== null && body !== undefined) headers["content-type"] = "application/json";
  try {
    const r = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === null || body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    try { await r.arrayBuffer(); } catch { /* an undrained body changes no verdict */ }
    return r.status;
  } catch {
    return null;
  }
}

/** Run the whole matrix. Serialized on purpose: the tts probe is a real
 *  synthesis, and a CI job must not burst a CPU-bound box. */
export async function proveKeys({ base, secret, granted, voice = DEFAULT_PROBE_VOICE, timeoutMs = 15000, synthTimeoutMs = 60000 }) {
  const postureStatus = await probeStatus(base, POSTURE_PROBE.path, {
    method: POSTURE_PROBE.method, body: null, timeoutMs,
  });
  const posture = postureFrom(postureStatus);
  const checkedAt = new Date().toISOString();
  if (posture === "unreachable" || !secret) {
    return { posture, checkedAt, probes: [], negativesConclusive: false };
  }
  const grantedSet = new Set(granted);
  const probes = [];
  for (const spec of PROBES) {
    const path = spec.path.replace("{voice}", encodeURIComponent(voice));
    const expected = grantedSet.has(spec.scope) ? "allowed" : "refused";
    const status = await probeStatus(base, path, {
      method: spec.method, body: spec.body, secret,
      timeoutMs: spec.synthesizes ? synthTimeoutMs : timeoutMs,
    });
    const observed = observedFrom(status);
    probes.push({
      scope: spec.scope, expected, observed,
      verdict: verdictFor(expected, observed),
      status, request: `${spec.method} ${path}`,
    });
  }
  return { posture, checkedAt, probes, negativesConclusive: negativesAreConclusive(probes) };
}

export function exitCodeFor(result) {
  if (result.posture === "unreachable") return 2;
  if (result.posture === "open") return 1; // serving unauthenticated callers
  return result.probes.some((p) => p.verdict === "REFUSED-SCOPE-SERVED") ? 1 : 0;
}

async function main(argv) {
  const args = parseArgs(argv);
  if ("help" in args || "h" in args) {
    process.stdout.write(
      "prove-keys — probe a Gravitone deployment's key enforcement.\n\n" +
      "  --url <base>       default $GRAVITONE_URL or http://127.0.0.1:8080\n" +
      "  --key <secret>     default $GRAVITONE_PROBE_KEY; omit for posture only\n" +
      "  --scopes a,b       scopes the key was GRANTED (default $GRAVITONE_PROBE_SCOPES)\n" +
      "  --voice <id>       voice for the one-word tts probe (default alba)\n\n" +
      "Sends one real one-word synthesis when --key is given. Exit 1 on an open\n" +
      "deployment or any refused-scope-served row, 2 when nothing answered.\n",
    );
    return 0;
  }
  const base = (args.url || process.env.GRAVITONE_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
  const secret = args.key || process.env.GRAVITONE_PROBE_KEY || "";
  const scopesRaw = args.scopes ?? process.env.GRAVITONE_PROBE_SCOPES ?? "";
  const granted = scopesRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (secret && granted.length === 0) {
    process.stderr.write(
      "prove-keys: --scopes is required with --key (the granted list is what makes a probe positive or negative)\n",
    );
    return 3;
  }
  const result = await proveKeys({ base, secret, granted, voice: args.voice || DEFAULT_PROBE_VOICE });
  process.stdout.write(`${JSON.stringify({ url: base, ...result }, null, 2)}\n`);
  const code = exitCodeFor(result);
  if (code === 1) {
    const served = result.probes.filter((p) => p.verdict === "REFUSED-SCOPE-SERVED").map((p) => p.scope);
    process.stderr.write(
      result.posture === "open"
        ? "prove-keys: FAIL — this deployment served an unauthenticated request; its keys enforce nothing\n"
        : `prove-keys: FAIL — ungranted scopes served: ${served.join(", ")}\n`,
    );
  } else if (code === 2) {
    process.stderr.write(`prove-keys: nothing answered at ${base} — no posture proved\n`);
  }
  return code;
}

// Importable (the drift test reads the table above) without running anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
