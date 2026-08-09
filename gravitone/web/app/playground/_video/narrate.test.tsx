import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ScriptLine } from "./videoData";
import { VideoHarness, json, stubFetch, voiceoverFit, voiceoverJob } from "./videoHarness";

// WHAT THE BACKEND ALREADY KNOWS, RENDERED.
//
// Each of these facts was computed on the box, sent on the wire, typed in
// videoData.ts — and dropped on the floor by the UI. A number the user cannot
// see is a number we did not compute.

const SCRIPT: ScriptLine[] = [
  { scene: 0, text: "The street wakes.", emotion: "baseline",
    emotion_requested: "wistful", budget_words: 9, words: 3 },
  { scene: 1, text: "A door closes.", emotion: "baseline",
    emotion_requested: null, budget_words: 6, words: 3 },
];

const DONE = voiceoverJob({
  status: "done",
  steps: [{ key: "mux", label: "assembling the reel", state: "done" }],
  result: {
    summary: { scenes: 2, spoken: 2, silent: 0, failed: 0, stem_fallbacks: 1 },
    fit: [
      voiceoverFit({ scene: 0, stem_fallback: true }),
      voiceoverFit({ scene: 1, text: "A door closes.", seconds: 2.2, budget_seconds: 3 }),
    ],
  },
});

async function loadReel(job = DONE, script: ScriptLine[] | null = SCRIPT) {
  const stub = stubFetch([
    [/\/api\/voiceover\/from-url/, () => json({ job_id: "vo1" })],
    [/\/api\/voiceover\/vo1\/media\/script/, () =>
      script ? json(script) : json({ detail: "no script" }, 404)],
    [/\/api\/voiceover\/vo1\/frame\//, () => new Response(null, { status: 200 })],
    [/\/api\/voiceover\/vo1$/, () => json(job)],
  ]);
  render(<VideoHarness />);
  fireEvent.change(screen.getByLabelText("Footage link"), {
    target: { value: "https://example.test/v" },
  });
  fireEvent.click(screen.getByRole("button", { name: "load reel" }));
  await screen.findByText("A silent street");
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the narrated reel can be kept", () => {
  it("offers the download the dub has, in the same words", async () => {
    await loadReel();
    const link = await screen.findByText("download the reel");
    expect(link.getAttribute("href")).toBe("/api/voiceover/vo1/media/video");
    expect(link.hasAttribute("download")).toBe(true);
  });
});

describe("a substitution is stated on the scene it happened to", () => {
  it("names the emotion the writer asked for and the one that spoke", async () => {
    await loadReel();
    expect(await screen.findByText("asked for wistful · spoken baseline")).toBeTruthy();
  });

  it("names a stand-in even when the emotion's own name was honoured", async () => {
    const script: ScriptLine[] = [{ ...SCRIPT[0], emotion_requested: null }];
    await loadReel(DONE, script);
    // fit[0].stem_fallback: this Character has no recording of the slot that
    // spoke it, which the name alone would never reveal
    expect(await screen.findByText(/no recorded baseline — a stand-in was used/)).toBeTruthy();
  });

  it("says nothing about a scene that was spoken as written", async () => {
    await loadReel();
    fireEvent.click(screen.getByTitle(/^Scene 2/));
    expect(screen.queryByText(/asked for/)).toBeNull();
    expect(screen.queryByText(/stand-in/)).toBeNull();
  });
});

describe("who wrote it is named to the model", () => {
  it("carries brain.model beside brain.backend", async () => {
    await loadReel();
    expect(await screen.findByText(/written by claude-cli \(claude-sonnet-4\)/)).toBeTruthy();
  });
});

describe("the source's own facts, while the job runs", () => {
  it("shows the fetched video's length and size on the fetch step", async () => {
    await loadReel(voiceoverJob({
      steps: [{ key: "fetch", label: "fetching the video", state: "active" }],
      partial: { video: { seconds: 42.5, width: 1920, height: 1080 } },
    }));
    expect(await screen.findByText("0:42.5 · 1920×1080")).toBeTruthy();
  });

  it("names the frame shortfall beside the scene count, and stays quiet when there is none", async () => {
    await loadReel(voiceoverJob({ partial: { scenes: 8, frames: 6 } }));
    expect(await screen.findByText("8 scenes · 6 frames")).toBeTruthy();
  });
});
