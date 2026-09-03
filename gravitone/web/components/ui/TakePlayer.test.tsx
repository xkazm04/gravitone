import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import AudioBusProvider from "./AudioBus";
import TakePlayer from "./TakePlayer";
import { FakeAudioContext } from "./testFakes";

// TakePlayer replaces raw <audio controls>. Two things must be true forever:
// it must never leak browser chrome, and it must stay fully operable from the
// keyboard — a custom transport that only responds to the mouse is a regression
// against the native element it replaced.

beforeEach(() => {
  FakeAudioContext.reset();
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  // jsdom implements neither play() nor pause().
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function play(
    this: HTMLMediaElement,
  ) {
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function pause(
    this: HTMLMediaElement,
  ) {
    this.dispatchEvent(new Event("pause"));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mount(props: Partial<React.ComponentProps<typeof TakePlayer>> = {}) {
  const view = render(
    <AudioBusProvider>
      <TakePlayer src="blob:take-1" label="take" {...props} />
    </AudioBusProvider>,
  );
  const audio = view.container.querySelector("audio") as HTMLAudioElement;
  // Give the fake element a timeline (jsdom's currentTime/duration are inert).
  let t = 0;
  Object.defineProperty(audio, "currentTime", {
    configurable: true,
    get: () => t,
    set: (v: number) => {
      t = v;
    },
  });
  Object.defineProperty(audio, "duration", { configurable: true, get: () => 12 });
  Object.defineProperty(audio, "paused", { configurable: true, get: () => true });
  fireEvent.loadedMetadata(audio);
  return { ...view, audio };
}

describe("TakePlayer", () => {
  it("renders its own transport and never native controls", () => {
    const { audio } = mount();
    expect(audio.hasAttribute("controls")).toBe(false);
    expect(screen.getByRole("group", { name: "take" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play take" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Seek take" })).toBeTruthy();
  });

  it("labels the transport by state", () => {
    const { audio } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Play take" }));
    expect(screen.getByRole("button", { name: "Pause take" })).toBeTruthy();
    fireEvent.pause(audio);
    expect(screen.getByRole("button", { name: "Play take" })).toBeTruthy();
  });

  it("is seekable from the keyboard and reports position through aria", () => {
    const { audio } = mount();
    const rail = screen.getByRole("slider", { name: "Seek take" });
    expect(rail).toHaveAttribute("aria-valuemax", "12");

    fireEvent.keyDown(rail, { key: "ArrowRight" });
    expect(audio.currentTime).toBe(5);
    expect(rail).toHaveAttribute("aria-valuenow", "5");
    expect(rail).toHaveAttribute("aria-valuetext", "0:05 of 0:12");

    fireEvent.keyDown(rail, { key: "ArrowLeft" });
    expect(audio.currentTime).toBe(0);

    fireEvent.keyDown(rail, { key: "End" });
    expect(audio.currentTime).toBe(12);

    fireEvent.keyDown(rail, { key: "Home" });
    expect(audio.currentTime).toBe(0);
  });

  it("clamps a seek to the take's bounds", () => {
    const { audio } = mount();
    const rail = screen.getByRole("slider", { name: "Seek take" });
    fireEvent.keyDown(rail, { key: "ArrowLeft" });
    expect(audio.currentTime).toBe(0);
    fireEvent.keyDown(rail, { key: "End" });
    fireEvent.keyDown(rail, { key: "ArrowRight" });
    expect(audio.currentTime).toBe(12);
  });

  it("reports the end of the take and resets", () => {
    const onEnded = vi.fn();
    const { audio } = mount({ onEnded });
    fireEvent.timeUpdate(audio);
    fireEvent.ended(audio);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("slider", { name: "Seek take" })).toHaveAttribute("aria-valuenow", "0");
  });

  it("names an unplayable source instead of freezing mid-play", () => {
    const { audio } = mount();
    fireEvent.error(audio);
    expect(screen.getByText("unplayable")).toBeTruthy();
  });

  it("registers its element with the bus and keeps it audible", () => {
    const { audio } = mount();
    const ctx = FakeAudioContext.last!;
    expect(ctx.elementSources).toHaveLength(1);
    expect(ctx.elementSources[0].el).toBe(audio);
    expect(ctx.elementSources[0].connectedTo(ctx.destination)).toBe(true);
  });

  it("plays immediately when asked to autoplay", () => {
    mount({ autoPlay: true });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("tells its caller when the source will not play", () => {
    const onFail = vi.fn();
    const { audio } = mount({ onFail });
    expect(onFail).not.toHaveBeenCalled();
    fireEvent.error(audio);
    // The pill can only ever say "unplayable" — it never sees the response
    // body — so a surface that can go and ask WHY has to be told.
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(screen.getByText("unplayable")).toBeTruthy();
  });
});

// The rule lives in the shared transport, so it holds between ANY two surfaces
// that adopt it — which is the point: the ingest studio's private `new Audio()`
// and the Casting Board's players could talk over each other precisely because
// they were not the same transport.
describe("one clip at a time", () => {
  /** Two players, plus a record of which elements were actually paused. */
  function pair() {
    const view = render(
      <AudioBusProvider>
        <TakePlayer src="blob:take-1" label="first" />
        <TakePlayer src="blob:take-2" label="second" />
      </AudioBusProvider>,
    );
    const [a, b] = Array.from(view.container.querySelectorAll("audio"));
    const paused: string[] = [];
    a.addEventListener("pause", () => paused.push("first"));
    b.addEventListener("pause", () => paused.push("second"));
    return { view, a, b, paused };
  }

  it("pauses whatever was playing when a second clip starts", () => {
    const { paused } = pair();
    fireEvent.click(screen.getByRole("button", { name: "Play first" }));
    expect(screen.getByRole("button", { name: "Pause first" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Play second" }));
    // The first ELEMENT was paused — not merely re-labelled.
    expect(paused).toEqual(["first"]);
    expect(screen.getByRole("button", { name: "Play first" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause second" })).toBeTruthy();
  });

  it("does not pause a clip on behalf of one that never started", async () => {
    // Driven by the play EVENT, not the play() call: a refused play must not
    // take the clip that IS playing down with it.
    const { paused } = pair();
    fireEvent.click(screen.getByRole("button", { name: "Play first" }));
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
      () => Promise.reject(new Error("refused")),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Play second" }));
    });
    expect(paused).toEqual([]);
    expect(screen.getByRole("button", { name: "Pause first" })).toBeTruthy();
  });

  it("stops speaking for a player that has left the page", () => {
    const { view } = pair();
    fireEvent.click(screen.getByRole("button", { name: "Play first" }));
    view.unmount();
    // Nothing to assert but the absence of a throw: the unmounted element must
    // not stay the one every future clip pauses.
    const second = render(
      <AudioBusProvider>
        <TakePlayer src="blob:take-3" label="third" />
      </AudioBusProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Play third" }));
    expect(screen.getByRole("button", { name: "Pause third" })).toBeTruthy();
    second.unmount();
  });
});
