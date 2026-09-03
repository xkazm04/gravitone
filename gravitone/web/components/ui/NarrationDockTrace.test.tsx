import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// ── a broken bake is not the same as no bake ─────────────────────────────────
//
// Both look identical to a visitor, and that is correct: the reading falls
// through to live synthesis either way. What these tests pin is that they are no
// longer identical to whoever is RESPONSIBLE for the deployment — a manifest
// that promises clips the server will not serve leaves a trace, and a prefetch
// that is refused leaves one too, instead of vanishing into `catch(() => {})`.

// jsdom ships no IndexedDB, so the real cache latches "unavailable" on the first
// clip — which would disable the lookahead these tests are about. The cache is
// not what is under test here; it is stubbed to a permanent, working miss.
vi.mock("@/lib/narrationCache", () => ({
  cacheAvailable: () => true,
  getClip: async () => null,
  putClip: async () => true,
  countClips: async () => 0,
  clearClips: async () => {},
}));

let mockPath = "/";
vi.mock("next/navigation", () => ({ usePathname: () => mockPath }));

import { NARRATABLE, clipKey, narrationPlan } from "@/lib/narratable";
import NarrationDock from "./NarrationDock";
import { narrationTrace, resetNarrationTrace } from "./narrationDockSynthesis";

const ALBA = { character_id: "alba", name: "Alba", category: "premade", tags: ["warm"] };

function wav(): Blob {
  return new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])], { type: "audio/wav" });
}

const keyAt = (i: number) => {
  const step = narrationPlan(NARRATABLE["/"])[i];
  return clipKey("alba", step.block, step.sentence);
};

const pill = () => screen.getByRole("button", { name: /listen to this page/i });
const status = () => screen.getByRole("status");
const play = () => screen.getByRole("button", { name: /play the narration/i });

/** Roster + manifest + a per-URL responder for everything else. */
function serve(manifest: unknown | null, responder: (url: string) => Response) {
  const seen: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    seen.push(url);
    if (url.includes("/api/characters")) {
      return new Response(JSON.stringify([ALBA]), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/narration/manifest.json")) {
      return manifest
        ? new Response(JSON.stringify(manifest), {
            status: 200, headers: { "Content-Type": "application/json" } })
        : new Response("", { status: 404 });
    }
    return responder(url);
  });
  return seen;
}

const manifestFor = (clips: Record<string, number>) => ({
  version: 1, character_id: "alba", character_name: "Alba",
  generated: "2026-07-30T00:00:00Z", clips,
});

beforeEach(() => {
  mockPath = "/";
  resetNarrationTrace();
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:narration");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a deployment with no bake at all", () => {
  it("synthesizes live and leaves NO trace — nothing went wrong", async () => {
    const seen = serve(null, (url) =>
      url.includes("/api/speak") ? new Response(wav(), { status: 200 })
        : new Response("", { status: 404 }));
    render(<NarrationDock />);
    fireEvent.click(pill());
    await screen.findByRole("option", { name: "Alba" });
    fireEvent.click(play());
    await waitFor(() => expect(status()).toHaveTextContent(/rendered just now/i));

    expect(seen.some((u) => u.includes("/api/speak"))).toBe(true);
    expect(seen.some((u) => /\/narration\/[0-9a-f]{16}\.wav$/.test(u))).toBe(false);
    expect(narrationTrace()).toEqual([]);
  });
});

describe("a bake this deployment cannot serve", () => {
  it("still reads the page, but says so and records WHICH clip and WHY", async () => {
    const key = keyAt(0);
    const seen = serve(manifestFor({ [key]: 4096 }), (url) =>
      /\/narration\/[0-9a-f]{16}\.wav$/.test(url) ? new Response("", { status: 404 })
        : url.includes("/api/speak") ? new Response(wav(), { status: 200 })
          : new Response("", { status: 404 }));
    render(<NarrationDock />);
    fireEvent.click(pill());
    await waitFor(() => expect(status()).toHaveTextContent(/baked with Alba/i));

    fireEvent.click(play());
    // The visitor's reading is NOT harmed: it fell through to live synthesis.
    await waitFor(() => expect(status()).toHaveTextContent(/rendered just now/i));
    expect(seen.some((u) => u.endsWith(`/narration/${key}.wav`))).toBe(true);
    expect(seen.some((u) => u.includes("/api/speak"))).toBe(true);

    // …and it is distinguishable from "there is no manifest": named clip, named
    // status, named cause.
    const trace = narrationTrace();
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ kind: "bake-miss", key, status: 404 });
    expect(trace[0].detail).toMatch(/manifest promises/i);

    // No banner, no alarm — the claim that the page costs no engine is simply
    // retired, because it has been disproved.
    fireEvent.click(screen.getByRole("button", { name: /stop the narration/i }));
    await waitFor(() => expect(status()).toHaveTextContent(/not being served/i));
    expect(status()).not.toHaveTextContent(/costs no engine/i);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the lookahead", () => {
  it("traces a refused prefetch instead of swallowing it, invisibly to the visitor", async () => {
    let speaks = 0;
    serve(null, (url) => {
      if (!url.includes("/api/speak")) return new Response("", { status: 404 });
      speaks += 1;
      // The sentence being read succeeds; the one being fetched ahead is
      // refused for backpressure — exactly the case that used to leave nothing.
      return speaks === 1
        ? new Response(wav(), { status: 200 })
        : new Response(JSON.stringify({ detail: "engine busy" }), {
            status: 429, headers: { "Content-Type": "application/json", "Retry-After": "3" } });
    });
    render(<NarrationDock />);
    fireEvent.click(pill());
    await screen.findByRole("option", { name: "Alba" });
    fireEvent.click(play());
    await waitFor(() => expect(status()).toHaveTextContent(/rendered just now/i));

    await waitFor(
      () => expect(narrationTrace().some((t) => t.kind === "prefetch-failed")).toBe(true),
      { timeout: 3000 },
    );
    expect(narrationTrace().find((t) => t.kind === "prefetch-failed")?.detail)
      .toMatch(/lookahead for sentence 2/i);
    // The visitor is still simply listening: the current sentence is playing and
    // the dock has not put a failure in front of them.
    expect(status()).toHaveTextContent(/rendered just now/i);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
