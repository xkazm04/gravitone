"use client";

// The test kit for the video round. NOT a test file itself (vitest only picks
// up *.test.tsx) — it exists so every test that needs a job actually running
// drives the REAL hooks through the REAL surfaces, rather than hand-building a
// `Reel`/`Dub` object that can drift from what the console mounts.
//
// The harness is deliberately the console's own wiring in miniature: the
// marquee (both verbs) plus the dub controls, which live in the compose bay in
// production and own the run/cancel button.

import { vi } from "vitest";
import { useReel } from "./useReel";
import { useDub, type DubLine } from "./useDub";
import Marquee from "./Marquee";
import { DubControls } from "./dubParts";
import type { RevoiceFit, StudioJob, VoiceoverFit } from "./videoData";

export function VideoHarness({ draft = [] }: { draft?: DubLine[] }) {
  const reel = useReel({ characterId: "sarah" });
  const dub = useDub();
  return (
    <>
      <Marquee reel={reel} dub={dub} draft={draft} characterName="Sarah" onStage={() => {}} />
      <DubControls dub={dub} lines={draft} />
    </>
  );
}

// ── fixtures, shaped exactly like service/voiceover_api.py's _PUBLIC_KEYS ────

export function voiceoverJob(over: Partial<StudioJob> = {}): StudioJob {
  return {
    id: "vo1",
    status: "running",
    step: "scenes",
    steps: [
      { key: "fetch", label: "fetching the video", state: "done" },
      { key: "scenes", label: "cutting it into scenes", state: "active" },
      { key: "look", label: "reading each scene", state: "pending" },
      { key: "write", label: "writing the narration", state: "pending" },
      { key: "speak", label: "speaking every line", state: "pending" },
      { key: "mux", label: "assembling the reel", state: "pending" },
    ],
    partial: { video: { seconds: 42.5, width: 1920, height: 1080 }, scenes: 3, frames: 3 },
    error: null,
    source: { kind: "url", url: "https://example.test/v", title: "A silent street" },
    brain: { backend: "claude-cli", model: "claude-sonnet-4" },
    limits: [],
    result: null,
    ...over,
  };
}

export function voiceoverFit(over: Partial<VoiceoverFit> = {}): VoiceoverFit {
  return {
    scene: 0, text: "The street wakes.", emotion: "baseline", stem_fallback: false,
    seconds: 3.1, budget_seconds: 4, spill_seconds: 0, clipped_seconds: 0,
    silent: false, error: null, ...over,
  };
}

export function revoiceJob(over: Partial<StudioJob> = {}): StudioJob {
  return {
    id: "rv1",
    status: "running",
    step: "speak",
    steps: [
      { key: "fetch", label: "fetching the video", state: "done" },
      { key: "direct", label: "composing the emotional read", state: "done" },
      { key: "speak", label: "re-performing every line", state: "active" },
      { key: "mux", label: "assembling the re-voiced video", state: "pending" },
    ],
    partial: { video: { seconds: 12, width: 1280, height: 720 }, spoken_done: 1, spoken_total: 4 },
    error: null,
    source: { kind: "url", url: "https://example.test/d", title: "A loud kitchen" },
    brain: { backend: "openai", model: "gpt-4o-mini" },
    limits: [],
    result: null,
    ...over,
  };
}

export function revoiceFit(over: Partial<RevoiceFit> = {}): RevoiceFit {
  return {
    i: 0, character_id: "sarah", emotion: "baseline", stem_fallback: false,
    emotion_requested: null, budget_seconds: 4, seconds: 3.5, method: "verbatim",
    atempo: null, rewritten_text: null, spill_seconds: 0, error: null, ...over,
  };
}

export function line(over: Partial<DubLine> = {}): DubLine {
  return { id: "l1", characterId: "sarah", text: "Get out of my kitchen.", start: 0, end: 4, ...over };
}

/** One fetch stub for the whole round: a route table keyed by what the URL
 *  contains, so a test says what the BOX answers and nothing else. Anything
 *  unrouted answers 500 with a named detail — an unexpected call is a test
 *  failure with an explanation, never a silent `{}`. */
export type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

export function stubFetch(routes: [RegExp, Route][]) {
  const calls: { url: string; method: string }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    for (const [pattern, route] of routes) {
      if (pattern.test(url)) return route(url, init);
    }
    return json({ detail: `unrouted in this test: ${init?.method ?? "GET"} ${url}` }, 500);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}
