import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Character } from "@/app/voices/_data/characters";

// The RE-VOICE round. Both directions put the same second verb on the marquee
// and differ only in where a dub's lines live, so what is pinned here is the
// part a design comparison rests on: the verb is shared, each direction's home
// for lines is where it says it is, and the console keeps working either way.

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

async function mount(node: React.ReactElement) {
  stubFetch();
  const view = render(node);
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

describe("the verb is shared, and absent from the console that shipped", () => {
  it("offers no re-voice verb without a direction", async () => {
    await mount(<PlaygroundConsole />);
    expect(screen.queryByRole("button", { name: "re-voice" })).toBeNull();
    // …and the narrate stage is untouched
    expect(screen.getByLabelText("Footage link")).toBeTruthy();
  });

  for (const direction of ["script", "bench"] as const) {
    it(`puts the same verb on the marquee in the ${direction} direction`, async () => {
      await mount(<PlaygroundConsole dub={direction} />);
      const verb = screen.getByRole("button", { name: "re-voice" });
      fireEvent.click(verb);
      await waitFor(() => expect(screen.getByLabelText("Dialogue video link")).toBeTruthy());
      // the source cannot be shown before the render, and the stage says so
      // rather than drawing an empty player
      expect(screen.getByText(/The picture arrives with the dub/)).toBeTruthy();
    });
  }
});

describe("dub sheet — the lines are script mode's, on a clock", () => {
  it("gives every script line an in and an out", async () => {
    await mount(<PlaygroundConsole dub="script" />);
    await toScript();
    // switching to script seeds the two-line demo; each line is now a slot
    expect(screen.getAllByLabelText("Slot in, seconds").length).toBe(2);
    expect(screen.getAllByLabelText("Slot out, seconds").length).toBe(2);
  });

  it("offers the dub as a second exit from the same composer", async () => {
    await mount(<PlaygroundConsole dub="script" />);
    await toScript();
    expect(screen.getByRole("button", { name: /Dub/ })).toBeTruthy();
    // …beside the one that makes a take, not instead of it
    expect(screen.getByRole("button", { name: /Generate/ })).toBeTruthy();
  });

  it("adds no sheet of its own", async () => {
    await mount(<PlaygroundConsole dub="script" />);
    expect(screen.queryByText("dub sheet")).toBeNull();
  });

  it("keeps the clock out of solo mode, which has no slots", async () => {
    await mount(<PlaygroundConsole dub="script" />);
    expect(screen.queryAllByLabelText("Slot in, seconds").length).toBe(0);
  });
});

describe("dub bench — the lines are its own", () => {
  it("stands under the picture with an empty sheet and says what a slot is", async () => {
    await mount(<PlaygroundConsole dub="bench" />);
    expect(screen.getByText("dub sheet")).toBeTruthy();
    expect(screen.getByText(/A slot is a stretch of the video/)).toBeTruthy();
  });

  it("adds slots without touching script mode", async () => {
    await mount(<PlaygroundConsole dub="bench" />);
    fireEvent.click(screen.getByRole("button", { name: /add slot/ }));
    await waitFor(() => expect(screen.getByLabelText("Words for slot 1")).toBeTruthy());
    expect(screen.getByLabelText("Slot in, seconds")).toBeTruthy();
    // script mode is left exactly as it was
    await toScript();
    expect(screen.queryAllByLabelText("Slot out, seconds").length).toBe(1); // the bench's, not a line's
  });

  it("refuses to run and says which thing is missing", async () => {
    await mount(<PlaygroundConsole dub="bench" />);
    expect(screen.getByText(/paste a link to the video/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Dub/ })).toBeDisabled();
  });
});
