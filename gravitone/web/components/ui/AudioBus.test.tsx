import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import AudioBusProvider, { busRegister, useAudioBus } from "./AudioBus";
import { FakeAudioContext, type FakeGain } from "./testFakes";

// The bus is the one piece of this batch whose failure modes are silent:
//  • a registered element that never reaches ctx.destination plays NOTHING;
//  • a mic stream that DOES reach ctx.destination screams feedback;
//  • a missing AudioContext must degrade, not throw, or the studio goes blank.
// So the assertions here are about the audio graph, not about markup.

// A hand-driven rAF queue. cancelAnimationFrame really removes the pending
// callback, so "the writer stopped" is observable rather than assumed.
let pending = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

function tick(times = 1) {
  for (let i = 0; i < times; i += 1) {
    const due = Array.from(pending.values());
    pending = new Map();
    act(() => {
      due.forEach((cb) => cb(1000 + i * 16));
    });
  }
}

/** Test surface: exposes the bus API imperatively. */
let api: ReturnType<typeof useAudioBus>;
function Probe() {
  api = useAudioBus();
  return null;
}

function mount() {
  const view = render(
    <AudioBusProvider>
      <Probe />
    </AudioBusProvider>,
  );
  const node = view.container.querySelector("[data-gt-bus]") as HTMLElement;
  return { ...view, node };
}

function audioEl() {
  return document.createElement("audio");
}

beforeEach(() => {
  FakeAudioContext.reset();
  pending = new Map();
  nextFrameId = 1;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextFrameId += 1;
    pending.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    pending.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AudioBus graph", () => {
  it("routes a registered media element to the destination as well as the analyser", () => {
    mount();
    const el = audioEl();
    act(() => api.register(el));

    const ctx = FakeAudioContext.last!;
    expect(ctx.elementSources).toHaveLength(1);
    const src = ctx.elementSources[0];
    expect(src.el).toBe(el);
    // THE test: without this edge the take is analysed and silent.
    expect(src.connectedTo(ctx.destination)).toBe(true);
    expect(src.connectedTo(ctx.analyser)).toBe(true);
  });

  it("taps a mic stream without ever routing it to the speakers", () => {
    mount();
    const stream = { id: "mic" } as unknown as MediaStream;
    act(() => api.registerStream(stream));

    const ctx = FakeAudioContext.last!;
    expect(ctx.streamSources).toHaveLength(1);
    const src = ctx.streamSources[0];
    expect(src.connectedTo(ctx.analyser)).toBe(true);
    expect(src.connectedTo(ctx.destination)).toBe(false);
  });

  it("drains the analyser through a zero-gain sink so a mic-only graph still renders", () => {
    mount();
    act(() => api.registerStream({ id: "mic" } as unknown as MediaStream));
    const ctx = FakeAudioContext.last!;
    const sink = ctx.gains[0] as FakeGain;
    expect(sink.gain.value).toBe(0);
    expect((ctx.analyser as unknown as FakeGain).connectedTo(sink)).toBe(true);
    expect(sink.connectedTo(ctx.destination)).toBe(true);
  });

  it("registers each element once and never re-creates a source node", () => {
    mount();
    const el = audioEl();
    act(() => api.register(el));
    act(() => api.register(el));
    expect(FakeAudioContext.last!.elementSources).toHaveLength(1);
  });

  it("leaves playback alone when the element cannot be tapped", () => {
    mount();
    act(() => api.register(audioEl())); // creates the context
    FakeAudioContext.last!.failElementSource = true;
    expect(() => act(() => api.register(audioEl()))).not.toThrow();
  });

  it("no-ops without throwing when the browser has no Web Audio", () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    const { node } = mount();
    expect(() => act(() => api.register(audioEl()))).not.toThrow();
    expect(node.getAttribute("data-gt-live")).toBeNull();
    expect(node.style.getPropertyValue("--gt-level")).toBe("");
  });

  it("closes the context on unmount", () => {
    const { unmount } = mount();
    act(() => api.register(audioEl()));
    const ctx = FakeAudioContext.last!;
    unmount();
    expect(ctx.closeCalls).toBe(1);
  });
});

describe("AudioBus channels", () => {
  it("writes level/peak/centroid on the single scoped node once a source is live", () => {
    const { node } = mount();
    expect(node.getAttribute("data-gt-live")).toBeNull();

    act(() => api.register(audioEl()));
    expect(node.getAttribute("data-gt-live")).toBe("1");
    tick(2);

    expect(Number(node.style.getPropertyValue("--gt-level"))).toBeGreaterThan(0);
    expect(Number(node.style.getPropertyValue("--gt-peak"))).toBeGreaterThan(0);
    expect(node.style.getPropertyValue("--gt-centroid")).not.toBe("");
  });

  it("reports brightness through --gt-centroid", () => {
    const { node } = mount();
    act(() => api.register(audioEl()));
    tick(1);
    const dark = Number(node.style.getPropertyValue("--gt-centroid"));
    FakeAudioContext.last!.analyser!.bright = true;
    tick(1);
    expect(Number(node.style.getPropertyValue("--gt-centroid"))).toBeGreaterThan(dark);
  });

  it("returns the channels to their defaults when the last source goes away", () => {
    const { node } = mount();
    const el = audioEl();
    act(() => api.register(el));
    tick(2);
    expect(node.style.getPropertyValue("--gt-level")).not.toBe("");

    act(() => api.unregister(el));
    expect(node.getAttribute("data-gt-live")).toBeNull();
    expect(node.style.getPropertyValue("--gt-level")).toBe("");
  });

  it("keeps an unregistered element connected to the destination (teardown must not mute)", () => {
    mount();
    const el = audioEl();
    act(() => api.register(el));
    const ctx = FakeAudioContext.last!;
    const src = ctx.elementSources[0];
    act(() => api.unregister(el));
    expect(src.connectedTo(ctx.destination)).toBe(true);
    expect(src.connectedTo(ctx.analyser)).toBe(false);
  });

  it("exposes working + hue channels", () => {
    const { node } = mount();
    act(() => api.setWorking(true));
    expect(node.style.getPropertyValue("--gt-working")).toBe("1");
    act(() => api.setHue(420));
    expect(node.style.getPropertyValue("--gt-hue")).toBe("60");
    act(() => api.setHue(null));
    expect(node.style.getPropertyValue("--gt-hue")).toBe("");
  });

  it("holds a static peak under prefers-reduced-motion (no oscillation)", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("reduce"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    // performance.now advances past the slow sampler window on the first frame
    // and not again, so a loud→quiet swing must NOT move the channel.
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValue(10_000);

    const { node } = mount();
    act(() => api.register(audioEl()));
    tick(1);
    const held = node.style.getPropertyValue("--gt-level");
    expect(Number(held)).toBeGreaterThan(0);
    // level and peak agree — one static indication, not a moving level
    expect(node.style.getPropertyValue("--gt-peak")).toBe(held);

    FakeAudioContext.last!.analyser!.amplitude = 2; // near silence
    tick(3);
    expect(node.style.getPropertyValue("--gt-level")).toBe(held);
  });

  it("stops the writer while the tab is hidden", () => {
    mount();
    act(() => api.register(audioEl()));
    tick(1);
    const reads = FakeAudioContext.last!.analyser!.timeReads;

    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    tick(3);
    expect(FakeAudioContext.last!.analyser!.timeReads).toBe(reads);
    hidden.mockRestore();
  });
});

describe("AudioBus lifecycle", () => {
  it("resumes a suspended context on the first user gesture", () => {
    mount();
    const el = audioEl();
    act(() => api.register(el));
    const ctx = FakeAudioContext.last!;
    ctx.state = "suspended";
    const before = ctx.resumeCalls;
    act(() => {
      window.dispatchEvent(new Event("pointerdown"));
    });
    expect(ctx.resumeCalls).toBeGreaterThan(before);
    expect(ctx.state).toBe("running");
  });

  it("busRegister forwards to the mounted bus and no-ops without one", () => {
    expect(() => busRegister(audioEl())).not.toThrow();
    const { unmount } = mount();
    const el = audioEl();
    act(() => busRegister(el));
    expect(FakeAudioContext.last!.elementSources[0].el).toBe(el);
    unmount();
    FakeAudioContext.reset();
    expect(() => busRegister(audioEl())).not.toThrow();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });
});
