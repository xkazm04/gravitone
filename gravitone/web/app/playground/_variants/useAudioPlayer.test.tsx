import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useAudioPlayer, usePlaybackProgress } from "./useAudioPlayer";
import type { Take } from "./playgroundHelpers";

// The playhead ticks ~4×/s. It used to be state in the console, so those ticks
// re-rendered a 1,700-line component whose take log is a list of layout-animated
// children — every one of them re-measuring, for the length of the clip. This
// file is the probe that keeps it out.

// The bus is where the hook hands over the element it built; borrowing that
// seam is how the test gets hold of it.
let element: HTMLAudioElement | null = null;
vi.mock("@/components/ui/AudioBus", () => ({
  busRegister: (el: HTMLAudioElement) => { element = el; },
}));

const TAKE: Take = {
  id: "take-1", text: "hello", characterId: "sarah", characterName: "Sarah",
  mode: "gravitone", url: "blob:take-1", peaks: [], seconds: 4, kb: 1, rtf: 1,
  synthSeconds: 1, queueSeconds: 0, ignoredSettings: [], segments: [],
  createdAt: 0, format: "wav",
} as unknown as Take;

/** The console's body: it OWNS the player and never reads the playhead. */
let bodyRenders = 0;
function Console() {
  const { progress, toggle } = useAudioPlayer();
  bodyRenders += 1;
  return (
    <>
      <button onClick={() => toggle(TAKE)}>play</button>
      <Meter source={progress} />
    </>
  );
}

/** …and the one thing on screen that moves with it. */
let meterRenders = 0;
function Meter({ source }: { source: ReturnType<typeof useAudioPlayer>["progress"] | null }) {
  const at = usePlaybackProgress(source);
  meterRenders += 1;
  return <output data-testid="wire">{at.toFixed(2)}</output>;
}

beforeEach(() => {
  element = null;
  bodyRenders = 0;
  meterRenders = 0;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

/** Play the take and give its element a timeline jsdom will not. */
async function playing() {
  render(<Console />);
  await act(async () => { fireEvent.click(screen.getByText("play")); });
  const el = element as HTMLAudioElement;
  let t = 0;
  Object.defineProperty(el, "currentTime", {
    configurable: true, get: () => t, set: (v: number) => { t = v; },
  });
  Object.defineProperty(el, "duration", { configurable: true, get: () => 4 });
  return el;
}

describe("playback progress is subscribed to, not re-rendered for", () => {
  it("does not re-render the player's owner on a timeupdate tick", async () => {
    const el = await playing();
    const settled = bodyRenders;

    for (const at of [1, 2, 3]) {
      el.currentTime = at;
      act(() => { fireEvent.timeUpdate(el); });
    }

    // Three ticks — in the old shape, three renders of everything.
    expect(bodyRenders).toBe(settled);
    expect(screen.getByTestId("wire")).toHaveTextContent("0.75");
  });

  it("re-renders the readers, and only them, once per tick", async () => {
    const el = await playing();
    const before = meterRenders;
    el.currentTime = 1;
    act(() => { fireEvent.timeUpdate(el); });
    expect(meterRenders).toBe(before + 1);
  });

  it("does not wake a reader when the position has not actually moved", async () => {
    const el = await playing();
    const before = meterRenders;
    act(() => { fireEvent.timeUpdate(el); }); // still at 0
    expect(meterRenders).toBe(before);
  });

  it("reads a flat 0 for a row that is not the playing one", () => {
    render(<Meter source={null} />);
    expect(screen.getByTestId("wire")).toHaveTextContent("0.00");
  });
});
