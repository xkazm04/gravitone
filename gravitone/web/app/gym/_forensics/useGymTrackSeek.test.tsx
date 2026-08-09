// The deep link "open this session AT this moment" is a race: the inspector
// mounts with a seek target, and the two aligned tracks may already know their
// duration (a cached WAV — the effect finds readyState >= 1 on its first pass)
// or may not (a cold load — the seek has to wait for `loadedmetadata`). Both
// branches are live, and a silent failure in either one lands the user at 0:00
// on a finding that is thirty seconds in, with nothing on screen saying so.

import { describe, expect, it } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";

import { useGymTrackSeek } from "./useGymTrackSeek";

type Stubbed = HTMLAudioElement & { __ready: number };

/** jsdom has no media pipeline: readyState is a fixed 0 and currentTime is not
 *  backed by anything. Both are stubbed per element so a test can say when the
 *  metadata arrived and read back where the track was moved to. */
function stub(el: HTMLAudioElement, ready: number): Stubbed {
  const s = el as Stubbed;
  if (Object.prototype.hasOwnProperty.call(s, "__ready")) return s;
  s.__ready = ready;
  let t = 0;
  Object.defineProperty(s, "readyState", { configurable: true, get: () => s.__ready });
  Object.defineProperty(s, "currentTime", {
    configurable: true,
    get: () => t,
    set: (v: number) => {
      t = v;
    },
  });
  return s;
}

function Tracks({ initialSeekS, ready }: { initialSeekS?: number; ready: number }) {
  const { userRef, agentRef, seekBoth } = useGymTrackSeek(initialSeekS);
  const attach =
    (ref: { current: HTMLAudioElement | null }) => (el: HTMLAudioElement | null) => {
      // Ref callbacks run at commit, BEFORE useEffect — which is what lets the
      // "already loaded" branch be exercised at all.
      if (el) stub(el, ready);
      ref.current = el;
    };
  return (
    <div>
      <audio data-testid="user" ref={attach(userRef)} />
      <audio data-testid="agent" ref={attach(agentRef)} />
      <button type="button" onClick={() => seekBoth(-4)}>
        seek back
      </button>
    </div>
  );
}

const tracks = (c: HTMLElement) => ({
  user: c.querySelector<Stubbed>('[data-testid="user"]')!,
  agent: c.querySelector<Stubbed>('[data-testid="agent"]')!,
});

describe("useGymTrackSeek — the initial-seek race", () => {
  it("seeks immediately when both tracks already know their duration", () => {
    const { container } = render(<Tracks initialSeekS={31.5} ready={1} />);
    const { user, agent } = tracks(container);
    expect(user.currentTime).toBe(31.5);
    expect(agent.currentTime).toBe(31.5);
  });

  it("waits for the metadata when the tracks load later, then seeks both", () => {
    const { container } = render(<Tracks initialSeekS={31.5} ready={0} />);
    const { user, agent } = tracks(container);
    // Nothing to seek to yet — a seek here would silently land at 0.
    expect(user.currentTime).toBe(0);

    // One track arriving is not enough: seeking now would leave the pair
    // misaligned, and alignment is the whole claim these two tracks make.
    act(() => {
      user.__ready = 1;
      fireEvent(user, new Event("loadedmetadata"));
    });
    expect(user.currentTime).toBe(0);

    act(() => {
      agent.__ready = 1;
      fireEvent(agent, new Event("loadedmetadata"));
    });
    expect(user.currentTime).toBe(31.5);
    expect(agent.currentTime).toBe(31.5);
  });

  it("seeks once — a later metadata event does not drag the user back", () => {
    const { container } = render(<Tracks initialSeekS={31.5} ready={1} />);
    const { user, agent } = tracks(container);
    user.currentTime = 60; // the user scrubbed away
    act(() => {
      fireEvent(user, new Event("loadedmetadata"));
    });
    expect(user.currentTime).toBe(60);
    expect(agent.currentTime).toBe(31.5);
  });

  it("never seeks at all without a target", () => {
    const { container } = render(<Tracks ready={1} />);
    expect(tracks(container).user.currentTime).toBe(0);
  });

  it("clamps a negative seek to the top of the call", () => {
    const { container, getByText } = render(<Tracks ready={1} />);
    fireEvent.click(getByText("seek back"));
    expect(tracks(container).user.currentTime).toBe(0);
  });
});
