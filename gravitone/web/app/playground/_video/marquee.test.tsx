import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Character } from "@/app/voices/_data/characters";

// The marquee won the video round: the picture is a stage above the console,
// not a mode you enter. What that decision is worth depends on two things
// staying true, so they are pinned here —
//
//   1. the stage is PART of the console (no toggle, no second page), and
//   2. adding it cost the console nothing: every composer, knob and log the
//      playground already had is still on the surface beside it.
//
// The harness mirrors PlaygroundConsole.test.tsx (roster + health over fetch,
// the two stores, the engine) because it mounts that same component.

const engineMocks = vi.hoisted(() => ({
  speak: vi.fn(),
  speakStreaming: vi.fn(),
  perform: vi.fn(),
  uploadTake: vi.fn(),
  refinePeaks: vi.fn(async () => null),
}));

vi.mock("@/lib/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/voiceVault", () => ({ recordVoiceOwnership: async () => ({ saved: 0, failed: 0 }) }));
vi.mock("../_variants/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../_variants/engine")>()),
  ...engineMocks,
}));
vi.mock("@/lib/takeStore", () => ({
  getRecentTakes: vi.fn(async () => []),
  putTake: vi.fn(async () => {}),
  deleteTake: vi.fn(async () => {}),
}));
vi.mock("@/lib/composerStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/composerStore")>()),
  loadComposer: vi.fn(async () => null),
  saveComposer: vi.fn(async () => {}),
}));

import PlaygroundConsole from "../_variants/PlaygroundConsole";

const SARAH: Character = {
  character_id: "sarah", name: "Sarah", category: "cloned", tags: [], lang: "en",
  voices: [], emotions: ["baseline"], coverage: 1, total: 8,
};

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = url.includes("/api/characters") ? [SARAH]
      : url.includes("/api/reviews/preferred") ? { character_id: null, picks: 0 }
      : url.includes("/api/health") ? { status: "ready", metrics: { queued: 0, in_flight: 0 } }
      : { detail: `unexpected: ${url}` };
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }));
}

async function mountConsole() {
  stubFetch();
  const view = render(<PlaygroundConsole />);
  await screen.findByRole("button", { name: /Sarah/, pressed: true });
  return view;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the stage is part of the console", () => {
  it("is on the page without being asked for, and adds no mode to enter", async () => {
    await mountConsole();
    expect(screen.getByLabelText("Footage link")).toBeTruthy();
    // the losing direction was a fourth pill beside solo/script/live
    expect(screen.queryByRole("button", { name: "reel" })).toBeNull();
  });

  it("narrates with the rail's Character rather than picking a second one", async () => {
    await mountConsole();
    await waitFor(() => expect(screen.getByText(/Sarah narrates/)).toBeTruthy());
  });

  it("says who narrates even before a link is pasted", async () => {
    // the door's blocked reason must never be the ONLY thing it says: a user
    // who cannot see the voice they are about to commit a whole reel to will
    // find out after paying for the render.
    await mountConsole();
    const narrator = await screen.findByText(/Sarah narrates/);
    expect(narrator.textContent).toContain("Sarah");
  });
});

describe("the console it stands on is untouched", () => {
  it("still offers every composer, knob and log it had", async () => {
    await mountConsole();
    for (const m of ["solo", "script", "live"]) {
      expect(screen.getByRole("button", { name: m })).toBeTruthy();
    }
    expect(screen.getByText("expression")).toBeTruthy();
    expect(screen.getByText("takes")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Generate/ })).toBeTruthy();
  });
});
