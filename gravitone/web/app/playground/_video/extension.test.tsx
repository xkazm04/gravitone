import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Character } from "@/app/voices/_data/characters";

// The video extension is a PROTOTYPE ROUND on a shipped surface, so the one
// thing that must be true is the thing a design comparison rests on: all three
// tabs are the same console, and the console with no direction chosen is the
// console that shipped. These tests assert exactly that, plus each direction's
// own entry point.
//
// The harness mirrors PlaygroundConsole.test.tsx (roster/health over fetch,
// the two stores, the engine) because it mounts the same component.

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

async function mount(node: React.ReactElement) {
  stubFetch();
  const view = render(node);
  await screen.findByRole("button", { name: /Sarah/, pressed: true });
  return view;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the console with no direction chosen is the console that shipped", () => {
  it("offers no reel pill and no picture surface", async () => {
    await mount(<PlaygroundConsole />);
    expect(screen.queryByRole("button", { name: "reel" })).toBeNull();
    expect(screen.queryByLabelText("Footage link")).toBeNull();
    // …and every composer it always had is still there
    expect(screen.getByRole("button", { name: "solo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "script" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "live" })).toBeTruthy();
  });
});

describe("bay — the picture is contained in the compose bay", () => {
  it("adds a reel pill beside the modes and opens the door inside the bay", async () => {
    await mount(<PlaygroundConsole video="bay" />);
    const pill = screen.getByRole("button", { name: "reel" });
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    // the door is not on the page until the pill is pressed: containment means
    // the console looks untouched until you ask for a picture
    expect(screen.queryByLabelText("Footage link")).toBeNull();
    pill.click();
    await waitFor(() => expect(screen.getByLabelText("Footage link")).toBeTruthy());
    expect(screen.getByRole("button", { name: "reel" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the console's own knobs and take log while the reel is open", async () => {
    await mount(<PlaygroundConsole video="bay" />);
    screen.getByRole("button", { name: "reel" }).click();
    await waitFor(() => expect(screen.getByLabelText("Footage link")).toBeTruthy());
    expect(screen.getByText("expression")).toBeTruthy();
    expect(screen.getByText("takes")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Generate/ })).toBeTruthy();
  });
});

describe("marquee — the picture is above everything", () => {
  it("shows the stage without being asked, and adds no mode", async () => {
    await mount(<PlaygroundConsole video="marquee" />);
    expect(screen.getByLabelText("Footage link")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "reel" })).toBeNull();
  });

  it("names the Character that will narrate rather than picking a second one", async () => {
    await mount(<PlaygroundConsole video="marquee" />);
    await waitFor(() => expect(screen.getByText(/Sarah narrates/)).toBeTruthy());
  });
});
