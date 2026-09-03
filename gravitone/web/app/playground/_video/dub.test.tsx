import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Character } from "@/app/voices/_data/characters";

// THE DUB SHEET — the marquee's second verb, and the thing it won its round
// on: a dub is a multi-character script pinned to someone else's clock, and
// this console already has a multi-character script composer, so script mode
// grows a clock instead of gaining a rival surface.
//
// What is pinned here is what that decision promised: the clock lives on the
// line, the dub is a second exit from the same composer rather than a
// replacement for the first, and nothing is claimed about a line that was not
// actually dubbed.

const engineMocks = vi.hoisted(() => ({
  speak: vi.fn(),
  speakStreaming: vi.fn(),
  perform: vi.fn(),
  uploadTake: vi.fn(),
  refinePeaks: vi.fn(async () => null),
}));

vi.mock("@/lib/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/voiceVault", () => ({ recordVoiceOwnership: async () => ({ saved: 0, failed: 0 }) }));
vi.mock("../_variants/playgroundEngine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../_variants/playgroundEngine")>()),
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

const ROSTER: Character[] = [
  { character_id: "sarah", name: "Sarah", category: "cloned", tags: [], lang: "en",
    voices: [], emotions: ["baseline"], coverage: 1, total: 8 },
  { character_id: "bo", name: "Bo", category: "cloned", tags: [], lang: "en",
    voices: [], emotions: ["baseline"], coverage: 1, total: 8 },
];

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = url.includes("/api/characters") ? ROSTER
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

/** Put the console in script mode, where its multi-character composer lives. */
async function toScript() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "script" }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("one picture, two verbs", () => {
  it("offers re-voice beside narrate on the same stage", async () => {
    await mountConsole();
    expect(screen.getByRole("button", { name: "narrate" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "re-voice" }));
    await waitFor(() => expect(screen.getByLabelText("Dialogue video link")).toBeTruthy());
  });

  it("says the source cannot be shown before the render instead of drawing a dead player", async () => {
    await mountConsole();
    fireEvent.click(screen.getByRole("button", { name: "re-voice" }));
    await waitFor(() =>
      expect(screen.getByText(/The picture arrives with the dub/)).toBeTruthy());
  });
});

describe("the sheet is script mode, on a clock", () => {
  it("gives every script line an in and an out", async () => {
    await mountConsole();
    await toScript();
    // switching to script seeds the two-line demo; each line is now a slot
    expect(screen.getAllByLabelText("Slot in, seconds").length).toBe(2);
    expect(screen.getAllByLabelText("Slot out, seconds").length).toBe(2);
  });

  it("adds no sheet of its own — the composer IS the sheet", async () => {
    await mountConsole();
    await toScript();
    expect(screen.queryByText("dub sheet")).toBeNull();
    expect(screen.queryByRole("button", { name: /add slot/ })).toBeNull();
  });

  it("keeps the clock out of solo mode, which has no slots", async () => {
    await mountConsole();
    expect(screen.queryAllByLabelText("Slot in, seconds").length).toBe(0);
  });
});

describe("the dub is a second exit, not a replacement", () => {
  it("stands beside Generate rather than instead of it", async () => {
    await mountConsole();
    await toScript();
    expect(screen.getByRole("button", { name: /Dub/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Generate/ })).toBeTruthy();
  });

  it("refuses to run and names the thing that is missing", async () => {
    await mountConsole();
    await toScript();
    // the demo script has words, so the source link is what is missing
    expect(screen.getByText(/paste a link to the video/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Dub/ })).toBeDisabled();
  });

  it("claims nothing about a line that was never dubbed", async () => {
    await mountConsole();
    await toScript();
    expect(screen.queryByText("not dubbed yet")).toBeNull();
    expect(screen.queryByText(/spoken as/)).toBeNull();
  });
});
