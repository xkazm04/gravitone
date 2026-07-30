// ── bake-narration: the site's reading, rendered once ────────────────────────
//
//   npm run bake:narration
//
// Walks the narratable registry (lib/narratable), splits every block into the
// same sentences the dock plays, and renders each one through the SAME service
// route the dock would have called — writing the result to
// `public/narration/<clipKey>.wav` plus a manifest the dock reads on expand.
//
// Why this exists, in one sentence: an uncached page reading is ~40 synthesis
// requests, and a landing page that costs 40 synth slots per visitor cannot
// face real traffic. Baked, it costs a static file.
//
// Three properties this script will not trade away:
//
//  1. THE KEY IS THE DOCK'S KEY. `clipKey(characterId, block, sentence)` is
//     imported from the same module the browser imports. A bake that invented
//     its own naming would produce files nothing ever looks up, and the failure
//     would be silent — every listen would just re-synthesize while a directory
//     full of correct audio sat unused.
//  2. IT DEGRADES BY NAME, NEVER BY CRASH. No service, no key, a 503 mid-run:
//     each prints what happened and what the consequence is ("the dock will
//     render live"), and the script exits 0 so a build is never blocked by an
//     optimization. The one exception is `--strict`, for a release pipeline
//     that WANTS a missing bake to fail.
//  3. IT IS INCREMENTAL. A clip whose key already exists on disk is not
//     re-rendered, so an edit to one sentence costs one request. Files whose
//     keys are no longer in the registry are deleted — a stale clip is audio of
//     copy the site no longer shows.
//
// Run it against a local service (`TTS_HOST`/`GRAVITONE_SERVICE_URL`, default
// http://127.0.0.1:8080) with a key in `GRAVITONE_API_KEY`/`TTS_API_KEY`.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { argv, env, exit } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  BakeManifest, NarratableBlock, NarratableRoute, NarrationStep,
} from "../lib/narratable";

// ── configuration ────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..", "public", "narration");
const MANIFEST = join(OUT_DIR, "manifest.json");

/** Two names because two audiences: `TTS_HOST` is what the service's own
 *  tooling uses, `GRAVITONE_SERVICE_URL` is what web/.env.example documents. */
export function serviceUrl(e: Record<string, string | undefined> = env): string {
  return (e.GRAVITONE_SERVICE_URL || e.TTS_BASE_URL || e.TTS_HOST || "http://127.0.0.1:8080")
    .replace(/\/+$/, "");
}

export function serviceKey(e: Record<string, string | undefined> = env): string {
  return e.GRAVITONE_API_KEY || e.TTS_API_KEY || "";
}

/** Named degradations. Exported so the test can assert the exact sentences —
 *  "it printed something" is not the same promise as "it said what happened". */
export const NOTICE = {
  unreachable: (url: string) =>
    `narration bake skipped: the service at ${url} is unreachable. ` +
    `The dock will render live audio instead — nothing is broken, nothing is baked.`,
  noKey: (url: string) =>
    `narration bake skipped: no GRAVITONE_API_KEY (or TTS_API_KEY) is set, and ` +
    `${url} requires one. The dock will render live audio instead.`,
  noCharacters:
    "narration bake skipped: this deployment has no Characters to read with. " +
    "The dock will say the same thing to visitors.",
  refused: (status: number, detail: string) =>
    `narration bake stopped after HTTP ${status}: ${detail}. ` +
    `Clips already written are kept and will be used; the rest render live.`,
} as const;

// ── the registry, loaded from a plain node process ───────────────────────────

/**
 * Import a TypeScript module from the web app without a bundler.
 *
 * Node 22+ strips types natively, so `lib/narratable.ts` runs as-is — but its
 * imports are EXTENSIONLESS (`./content`), which is a bundler convention that
 * Node's ESM resolver does not implement and never will. A synchronous resolve
 * hook adds the extension back for relative specifiers that resolve to a real
 * `.ts`/`.tsx` file, which is the smallest possible bridge: no loader process,
 * no transpile step, no devDependency, and nothing outside this script.
 */
function bridgeTypeScriptResolution(): void {
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL) {
        for (const ext of [".ts", ".tsx"]) {
          const candidate = new URL(specifier + ext, context.parentURL);
          if (existsSync(fileURLToPath(candidate))) return next(specifier + ext, context);
        }
      }
      return next(specifier, context);
    },
  });
}

type Registry = {
  NARRATABLE: Record<string, NarratableRoute>;
  narrationPlan: (route: NarratableRoute) => NarrationStep[];
  clipKey: (characterId: string, block: NarratableBlock, sentence: string) => string;
  taggedSentence: (block: NarratableBlock, sentence: string) => string;
};

async function loadRegistry(): Promise<Registry> {
  bridgeTypeScriptResolution();
  // Assembled rather than written as a literal ON PURPOSE: tsconfig has no
  // `allowImportingTsExtensions`, so a literal "../lib/narratable.ts" would be
  // a type error, while the extensionless form Node cannot resolve. The types
  // come from the `import type` above, which is erased before Node sees it.
  const specifier = "../lib/narratable" + ".ts";
  return (await import(specifier)) as Registry;
}

// ── the service ──────────────────────────────────────────────────────────────

type Narrator = { character_id: string; name: string; category?: string; tags?: string[] };

const HINT_MATCH: Record<string, RegExp> = {
  warm: /warm|bright|friendly|happy|soft/i,
  measured: /narration|calm|neutral|deep|documentary|measured/i,
};

/** The bake commits to ONE narrator for the whole site.
 *
 *  The dock's `pickNarrator` can vary the voice per section because it has a
 *  live roster; a bake cannot, because the file name carries the character id
 *  and a listener who picks someone else must fall through to live synthesis
 *  anyway. So: the explicitly requested character, else the first that reads
 *  "warm" (the lead block's hint, and the voice a first-time visitor hears),
 *  else a premade, else the first on the roster. */
export function pickBakeNarrator(roster: Narrator[], requested: string): Narrator | null {
  if (!roster.length) return null;
  if (requested) return roster.find((c) => c.character_id === requested) ?? null;
  const warm = roster.find(
    (c) => (c.tags ?? []).some((t) => HINT_MATCH.warm.test(t)) || HINT_MATCH.warm.test(c.name));
  return warm ?? roster.find((c) => c.category === "premade") ?? roster[0];
}

function headers(key: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (key) h["xi-api-key"] = key;
  return h;
}

async function detailOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return typeof body?.detail === "string" ? body.detail : res.statusText;
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

// ── the run ──────────────────────────────────────────────────────────────────

type Result = { baked: number; reused: number; pruned: number; notice: string | null };

export async function bake(options: { strict?: boolean; character?: string } = {}): Promise<Result> {
  const url = serviceUrl();
  const key = serviceKey();
  const result: Result = { baked: 0, reused: 0, pruned: 0, notice: null };

  let roster: Narrator[];
  try {
    const res = await fetch(`${url}/v1/characters`, { headers: headers(key) });
    if (res.status === 401 || res.status === 403) {
      result.notice = NOTICE.noKey(url);
      return result;
    }
    if (!res.ok) {
      result.notice = NOTICE.refused(res.status, await detailOf(res));
      return result;
    }
    roster = (await res.json()) as Narrator[];
  } catch {
    result.notice = NOTICE.unreachable(url);
    return result;
  }

  const narrator = pickBakeNarrator(Array.isArray(roster) ? roster : [], options.character ?? "");
  if (!narrator) {
    result.notice = NOTICE.noCharacters;
    return result;
  }

  const { NARRATABLE, narrationPlan, clipKey, taggedSentence } = await loadRegistry();
  mkdirSync(OUT_DIR, { recursive: true });

  const wanted = new Map<string, { block: NarratableBlock; sentence: string }>();
  for (const route of Object.values(NARRATABLE)) {
    for (const step of narrationPlan(route)) {
      wanted.set(clipKey(narrator.character_id, step.block, step.sentence),
                 { block: step.block, sentence: step.sentence });
    }
  }

  const clips: Record<string, number> = {};
  for (const [clip, { block, sentence }] of wanted) {
    const file = join(OUT_DIR, `${clip}.wav`);
    if (existsSync(file)) {
      result.reused += 1;
      clips[clip] = statSync(file).size;
      continue;
    }
    let res: Response;
    try {
      res = await fetch(`${url}/v1/speak`, {
        method: "POST",
        headers: headers(key),
        body: JSON.stringify({
          character_id: narrator.character_id,
          text: taggedSentence(block, sentence),
        }),
      });
    } catch {
      result.notice = NOTICE.unreachable(url);
      break;
    }
    if (!res.ok) {
      result.notice = NOTICE.refused(res.status, await detailOf(res));
      break;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    writeFileSync(file, bytes);
    clips[clip] = bytes.byteLength;
    result.baked += 1;
  }

  // Fill in sizes for reused clips and prune what the registry no longer says.
  for (const name of readdirSync(OUT_DIR)) {
    if (!name.endsWith(".wav")) continue;
    const clip = name.slice(0, -4);
    if (!wanted.has(clip)) {
      rmSync(join(OUT_DIR, name), { force: true });
      result.pruned += 1;
      delete clips[clip];
    }
  }

  const manifest: BakeManifest = {
    version: 1,
    character_id: narrator.character_id,
    character_name: narrator.name ?? narrator.character_id,
    generated: new Date().toISOString(),
    clips,
  };
  if (Object.keys(clips).length) {
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  } else {
    rmSync(MANIFEST, { force: true });
  }
  return result;
}

async function main(): Promise<void> {
  const strict = argv.includes("--strict");
  const characterFlag = argv.find((a) => a.startsWith("--character="));
  const result = await bake({ strict, character: characterFlag?.split("=")[1] ?? "" });
  if (result.notice) {
    console.warn(result.notice);
    if (strict) exit(1);
  }
  console.log(
    `narration bake: ${result.baked} rendered, ${result.reused} reused, ` +
    `${result.pruned} pruned -> public/narration/`);
}

// Imported by the test, executed by `npm run bake:narration`. Without this
// guard, importing the module to test `pickBakeNarrator` would start a bake.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  void main();
}
