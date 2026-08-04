import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { SharedTake } from "@/lib/takes";
import TakeStage from "./TakeStage";

// The share page used to run FIVE transports' worth of duplication: the card
// held a private `new Audio(url)`, so the score beside it — drawing the same
// take, over the same seconds — could not move playback and said so in a
// comment. These tests pin the consolidation: ONE element, both surfaces on it,
// and ONE segment display rather than a ribbon and a score saying the same
// thing an inch apart.

// The peaks are decoration and need a real AudioContext; the transport is what
// is under test.
vi.mock("@/app/playground/_variants/engine", () => ({
  computePeaks: vi.fn(async () => ({ peaks: [0.4, 0.8], duration: 4 })),
}));

const seg = (over: Partial<SharedTake["segments"][number]>): SharedTake["segments"][number] => ({
  text: "hello", requested: "baseline", used: "baseline", fallback: false, seconds: 1, ...over,
});

const TAKE: SharedTake = {
  id: "t1", character_id: "sarah", character_name: "Sarah", text: "one two",
  seconds: 4, rtf: 1, created: "",
  segments: [
    seg({ text: "one", seconds: 1 }),
    seg({ text: "two", used: "calm", requested: "whisper", fallback: true, seconds: 3 }),
  ],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["wav"]), { status: 200 })));
  // jsdom implements neither, and next/image needs the real URL constructor.
  URL.createObjectURL = () => "blob:take-1";
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function play(this: HTMLMediaElement) {
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function pause(this: HTMLMediaElement) {
    this.dispatchEvent(new Event("pause"));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Render the stage and give its one element a timeline jsdom will not. */
async function stage(take: SharedTake = TAKE) {
  const view = render(<TakeStage take={take} />);
  const audios = view.container.querySelectorAll("audio");
  expect(audios).toHaveLength(1); // ← the whole point
  const audio = audios[0] as HTMLAudioElement;
  let t = 0;
  Object.defineProperty(audio, "currentTime", {
    configurable: true, get: () => t, set: (v: number) => { t = v; },
  });
  Object.defineProperty(audio, "duration", { configurable: true, get: () => 4 });
  Object.defineProperty(audio, "paused", { configurable: true, get: () => true });
  await waitFor(() => expect(audio.getAttribute("src")).toBe("blob:take-1"));
  fireEvent.loadedMetadata(audio);
  return { ...view, audio };
}

describe("TakeStage — one transport under the card AND the score", () => {
  it("seeks the card's audio from the score's timeline", async () => {
    const { audio } = await stage();
    const rail = screen.getByRole("slider", { name: /Performance score/ });
    fireEvent.keyDown(rail, { key: "End" });
    expect(audio.currentTime).toBe(4);
    fireEvent.keyDown(rail, { key: "Home" });
    expect(audio.currentTime).toBe(0);
  });

  it("plays from the start of a selected span", async () => {
    const { audio } = await stage();
    // Segment two starts one second into a four-second take.
    fireEvent.click(screen.getByRole("button", { name: /Region 2 of 2/ }));
    expect(audio.currentTime).toBe(1);
  });

  it("moves the score's playhead with the card's playback", async () => {
    const { audio, container } = await stage();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    audio.currentTime = 2;
    fireEvent.timeUpdate(audio);
    const head = container.querySelector("[style*='box-shadow'][style*='left']") as HTMLElement;
    expect(head.style.left).toBe("50%");
  });

  it("shows the segments ONCE — the score, not the score and the ribbon", async () => {
    await stage();
    expect(screen.getByRole("slider", { name: /Performance score/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Segments in order" })).toBeNull();
  });

  it("falls back to the ribbon when the score has nothing it can draw", async () => {
    // Segments with no timing and no take duration cannot be PLACED, so the
    // score renders nothing — and the order is still worth showing.
    await stage({ ...TAKE, seconds: 0, segments: [seg({ seconds: 0 }), seg({ used: "calm", seconds: 0 })] });
    expect(screen.queryByRole("slider", { name: /Performance score/ })).toBeNull();
    expect(screen.getByRole("group", { name: "Segments in order" })).toBeInTheDocument();
  });

  it("says the take is unplayable rather than offering a dead play button", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    render(<TakeStage take={TAKE} />);
    await waitFor(() =>
      expect(screen.getByText(/audio unavailable — shares are evicted oldest-first/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /audio unavailable/ })).toBeDisabled();
  });
});
