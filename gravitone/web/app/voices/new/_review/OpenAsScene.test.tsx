// "Open as scene" — the last step of one video → many characters.
//
// Three properties are load-bearing, and all three are about NOT lying: a
// recording with no transcript renders an explanation instead of a dead button,
// a hand-off that could not be stored must not navigate as though it had, and
// what the scene leaves out (uncast speakers, truncated lines) is on screen
// BEFORE the click.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { push, saveComposer } = vi.hoisted(() => ({ push: vi.fn(), saveComposer: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/composerStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/composerStore")>()),
  saveComposer,
}));

import OpenAsScene from "./OpenAsScene";

const SCENE = {
  available: true,
  lines: [
    { speaker: "speaker_0", character_id: "ada", text: "You said you would call." },
    { speaker: "speaker_1", character_id: "bo", text: "I did call." },
  ],
  total_lines: 2, truncated: false, max_lines: 64, omitted: [],
  names: { ada: "Ada", bo: "Bo" },
};

const button = () => screen.queryByRole("button", { name: /open as scene/i });

function answer(body: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), {
    status: ok ? 200 : 404, headers: { "Content-Type": "application/json" },
  })));
}

beforeEach(() => {
  push.mockReset();
  saveComposer.mockReset();
  saveComposer.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("OpenAsScene", () => {
  it("loads the dialogue into the composer in script mode, then navigates", async () => {
    answer(SCENE);
    render(<OpenAsScene jobId="j1" />);
    await waitFor(() => expect(button()).not.toBeNull());
    fireEvent.click(button()!);

    await waitFor(() => expect(push).toHaveBeenCalledWith("/playground"));
    expect(saveComposer).toHaveBeenCalledWith(expect.objectContaining({
      mode: "script", charId: "ada",
      script: [
        expect.objectContaining({ characterId: "ada", text: "You said you would call." }),
        expect.objectContaining({ characterId: "bo", text: "I did call." }),
      ],
    }));
  });

  it("names who speaks how much before anything is opened", async () => {
    answer(SCENE);
    render(<OpenAsScene jobId="j1" />);
    expect(await screen.findByText(/Ada · 1 line/)).toBeInTheDocument();
  });

  it("explains an unavailable scene instead of rendering a dead button", async () => {
    answer({ available: false, reason: "this scan produced no transcript — sovereign mode finds speech by level and transcribes nothing" });
    render(<OpenAsScene jobId="j1" />);
    expect(await screen.findByText(/sovereign mode finds speech by level/)).toBeInTheDocument();
    expect(button()).toBeNull();
  });

  it("states what it is leaving out, before the click", async () => {
    answer({ ...SCENE, truncated: true, total_lines: 300,
      omitted: [{ speaker: "speaker_2", segments: 4 }] });
    render(<OpenAsScene jobId="j1" />);
    expect(await screen.findByText(/first 2 lines of 300/)).toBeInTheDocument();
    expect(screen.getByText(/speaker_2 \(4\)/)).toBeInTheDocument();
  });

  it("says so instead of navigating when the composer could not be stored", async () => {
    answer(SCENE);
    saveComposer.mockRejectedValueOnce(new Error("quota exceeded"));
    render(<OpenAsScene jobId="j1" />);
    await waitFor(() => expect(button()).not.toBeNull());
    fireEvent.click(button()!);

    expect(await screen.findByText(/quota exceeded/)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    expect(button()).toBeEnabled();
  });

  it("reports a transcript it could not fetch — and what is unaffected", async () => {
    answer({ detail: "job expired" }, false);
    render(<OpenAsScene jobId="j1" />);
    expect(await screen.findByText(/were still cast/)).toBeInTheDocument();
    expect(button()).toBeNull();
  });
});
