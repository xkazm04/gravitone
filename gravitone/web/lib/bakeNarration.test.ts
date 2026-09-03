// The bake script's tests live under lib/ rather than next to the script,
// because vitest.config.mts only collects `{app,lib,components}/**/*.test.*`
// and that config is not this batch's to edit.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NOTICE, bake, pickBakeNarrator, serviceKey, serviceUrl,
} from "../scripts/bake-narration";
import { NARRATABLE, clipKey, narrationPlan, parseManifest } from "./narratable";

// A build-time optimization has exactly one way to be dangerous: failing in a
// way that blocks a build, or succeeding in a way that produces files nothing
// looks up. Both are tested here; the second is the important one, because it
// fails SILENTLY in production (every listen just re-synthesizes).

describe("service addressing", () => {
  it("prefers the documented web variable, then the service's own", () => {
    expect(serviceUrl({ GRAVITONE_SERVICE_URL: "http://a:1/" })).toBe("http://a:1");
    expect(serviceUrl({ TTS_HOST: "http://b:2" })).toBe("http://b:2");
    expect(serviceUrl({})).toBe("http://127.0.0.1:8080");
  });

  it("has no key of its own", () => {
    expect(serviceKey({})).toBe("");
    expect(serviceKey({ TTS_API_KEY: "k" })).toBe("k");
  });
});

describe("pickBakeNarrator", () => {
  const roster = [
    { character_id: "c", name: "Cloned", category: "cloned", tags: [] },
    { character_id: "alba", name: "Alba", category: "premade", tags: ["warm"] },
  ];

  it("honours an explicit request, or refuses rather than substituting", () => {
    expect(pickBakeNarrator(roster, "c")?.character_id).toBe("c");
    // Substituting a different voice for a requested one would bake a whole
    // site in the wrong narrator and report success.
    expect(pickBakeNarrator(roster, "nobody")).toBeNull();
  });

  it("reaches for a warm voice on auto — the lead block's hint", () => {
    expect(pickBakeNarrator(roster, "")?.character_id).toBe("alba");
  });

  it("refuses an empty roster instead of inventing an id", () => {
    expect(pickBakeNarrator([], "")).toBeNull();
  });
});

// ── the run ──────────────────────────────────────────────────────────────────

const OUT = join(process.cwd(), "public", "narration");
const ALBA = { character_id: "alba", name: "Alba", category: "premade", tags: ["warm"] };

function wav(byte = 1): Uint8Array {
  return new Uint8Array([0x52, 0x49, 0x46, 0x46, byte, 0, 0, 0]);
}

/** Serve the roster and every synthesis call. Records the request bodies so a
 *  test can assert what was actually asked for. */
function serve(options: { roster?: unknown; rosterStatus?: number; speakStatus?: number } = {}) {
  const spoken: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/characters")) {
      return new Response(JSON.stringify(options.roster ?? [ALBA]), {
        status: options.rosterStatus ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/v1/speak")) {
      spoken.push(String((init as RequestInit | undefined)?.body ?? ""));
      if (options.speakStatus && options.speakStatus !== 200) {
        return new Response(JSON.stringify({ detail: "the engine is busy" }),
                            { status: options.speakStatus });
      }
      return new Response(wav().buffer as ArrayBuffer, { status: 200 });
    }
    throw new Error(`unexpected request to ${url}`);
  });
  return spoken;
}

/** public/narration is a real, git-tracked output directory; every test that
 *  writes into it puts it back exactly as it found it. */
let backup: string | null = null;

beforeEach(() => {
  backup = mkdtempSync(join(tmpdir(), "gt-bake-"));
  try {
    for (const name of readdirSync(OUT)) {
      writeFileSync(join(backup, name), readFileSync(join(OUT, name)));
    }
  } catch {
    /* the directory does not exist yet — the bake will create it */
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(OUT, { recursive: true, force: true });
  if (backup) {
    const names = readdirSync(backup);
    if (names.length) {
      for (const name of names) {
        writeFileSync(join(OUT, name), readFileSync(join(backup, name)));
      }
    }
    rmSync(backup, { recursive: true, force: true });
    backup = null;
  }
});

describe("bake", () => {
  it("writes clips under keys the DOCK computes, and a manifest naming them", async () => {
    serve();
    const result = await bake();
    expect(result.notice).toBeNull();
    expect(result.baked).toBeGreaterThan(0);

    const manifest = parseManifest(
      JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf-8")));
    expect(manifest?.character_id).toBe("alba");

    // The whole point: the key the browser will look up is present.
    const step = narrationPlan(NARRATABLE["/"])[0];
    const key = clipKey("alba", step.block, step.sentence);
    expect(manifest?.clips[key]).toBeGreaterThan(0);
    expect(readdirSync(OUT)).toContain(`${key}.wav`);
  });

  it("sends the same emotion-tagged text the dock would have sent", async () => {
    const spoken = serve();
    await bake();
    const first = JSON.parse(spoken[0]) as { character_id: string; text: string };
    expect(first.character_id).toBe("alba");
    expect(first.text).toMatch(/^\[[a-z_]+\].*\[\/[a-z_]+\]$/);
  });

  it("is incremental: a second run renders nothing and reuses everything", async () => {
    serve();
    const first = await bake();
    const second = await bake();
    expect(second.baked).toBe(0);
    expect(second.reused).toBe(first.baked);
  });

  it("prunes a clip the registry no longer asks for", async () => {
    serve();
    await bake();
    const stale = join(OUT, "deadbeefdeadbeef.wav");
    writeFileSync(stale, wav(2));
    const result = await bake();
    expect(result.pruned).toBe(1);
    expect(readdirSync(OUT)).not.toContain("deadbeefdeadbeef.wav");
  });

  it("degrades BY NAME when the service is unreachable, and writes nothing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await bake();
    expect(result.notice).toBe(NOTICE.unreachable(serviceUrl()));
    expect(result.notice).toMatch(/dock will render live/);
    expect(result.baked).toBe(0);
  });

  it("names a MISSING KEY as a key problem, not as an outage", async () => {
    serve({ rosterStatus: 401 });
    const result = await bake();
    expect(result.notice).toBe(NOTICE.noKey(serviceUrl()));
  });

  it("names a deployment with no Characters", async () => {
    serve({ roster: [] });
    expect((await bake()).notice).toBe(NOTICE.noCharacters);
  });

  it("keeps what it managed to render when synthesis starts refusing", async () => {
    serve({ speakStatus: 429 });
    const result = await bake();
    expect(result.notice).toMatch(/^narration bake stopped after HTTP 429: the engine is busy/);
    expect(result.notice).toMatch(/the rest render live/);
    expect(result.baked).toBe(0);
    // No manifest at all rather than an empty one promising clips that are not
    // there — the dock treats a missing manifest as "no bake", which is true.
    expect(readdirSync(OUT)).not.toContain("manifest.json");
  });
});
