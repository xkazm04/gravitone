// The guided capture session had no test at all — the one surface in this
// context where a user's microphone, a wall-clock timer and a destructive-ish
// upload meet. What is pinned here is the four promises the recorder makes
// about a take BEFORE it is cloned:
//
//   * a take under MIN_SECONDS cannot be cloned, and says why;
//   * the recording stops itself at MAX_SECONDS instead of running forever;
//   * a refused microphone is a stated failure, not a dead button;
//   * a re-record carries the measured defect into the session, in the
//     recorder's own voice — a measurement is only worth taking if it changes
//     what the user does next.
//
// NOT covered, because it does not exist yet: client-side silence/clipping
// detection at capture time. Today a bad take is only discovered server-side,
// after the upload — a real gap, and its own direction.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import GuidedRecorder from "./GuidedRecorder";
import { MAX_SECONDS, MIN_SECONDS } from "./useGuidedRecorderCapture";

// ── the browser halves jsdom does not implement ──────────────────────────────

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static stopped = 0;
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: MediaStream) { FakeRecorder.instances.push(this); }
  start() {}
  stop() {
    FakeRecorder.stopped += 1;
    this.ondataavailable?.({ data: new Blob(["take"]) });
    this.onstop?.();
  }
}

function fakeStream(): MediaStream {
  return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
}

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeRecorder.instances = [];
  FakeRecorder.stopped = 0;
  getUserMedia = vi.fn(async () => fakeStream());
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia }, configurable: true, writable: true,
  });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  // Add the two blob-URL methods jsdom lacks — WITHOUT replacing the `URL`
  // global, which would take the constructor with it, and next/image builds a
  // `new URL()` on every render of the header emblem.
  const url = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
  url.createObjectURL = vi.fn(() => "blob:take");
  url.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function renderRecorder(props: Partial<React.ComponentProps<typeof GuidedRecorder>> = {}) {
  const onClone = vi.fn(async (_emotion: string, _file: File) => {});
  render(
    <GuidedRecorder
      emotion="angry"
      characterName="Sarah"
      scale={["baseline", "angry", "happy"]}
      filledEmotions={["baseline"]}
      onClone={onClone}
      onClose={vi.fn()}
      onSwitch={vi.fn()}
      {...props}
    />,
  );
  return { onClone };
}

/** Record for `seconds` of wall clock, then press Stop. Fake timers only. */
async function recordFor(seconds: number) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(seconds * 1000); });
}

describe("GuidedRecorder — the length gate", () => {
  it("refuses to clone a take under the minimum, and says the minimum", async () => {
    vi.useFakeTimers();
    const { onClone } = renderRecorder();
    await recordFor(MIN_SECONDS - 5);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /stop/i })); });

    expect(screen.getByText(new RegExp(`too short — ${MIN_SECONDS}s minimum`))).toBeInTheDocument();
    const clone = screen.getByRole("button", { name: /clone angry/i });
    expect(clone).toBeDisabled();
    fireEvent.click(clone);
    expect(onClone).not.toHaveBeenCalled();
  });

  it("clones a take that clears the minimum", async () => {
    vi.useFakeTimers();
    const { onClone } = renderRecorder();
    await recordFor(MIN_SECONDS + 2);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /stop/i })); });

    expect(screen.queryByText(/too short/)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /clone angry/i }));
    });
    expect(onClone).toHaveBeenCalledTimes(1);
    expect(onClone.mock.calls[0][0]).toBe("angry");
    expect(screen.getByText(/Angry recorded/)).toBeInTheDocument();
  });

  it("surfaces a failed clone and leaves the take in hand to try again", async () => {
    vi.useFakeTimers();
    const onClone = vi.fn(async () => { throw new Error("the voice registry is unreadable"); });
    renderRecorder({ onClone });
    await recordFor(MIN_SECONDS + 2);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /stop/i })); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /clone angry/i }));
    });

    expect(screen.getByText(/the voice registry is unreadable/)).toBeInTheDocument();
    // Back in preview, holding the same take — the recording is not thrown away
    // because the upload failed.
    expect(screen.getByRole("button", { name: /clone angry/i })).toBeEnabled();
  });
});

describe("GuidedRecorder — the recording stops itself", () => {
  it("cuts the take at the maximum instead of running forever", async () => {
    vi.useFakeTimers();
    renderRecorder();
    await recordFor(MAX_SECONDS);

    expect(FakeRecorder.stopped).toBe(1);
    // …and it stops ONCE: the auto-stop lives outside the state updater exactly
    // so React 19's double-invoked updaters cannot fire it twice.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(FakeRecorder.stopped).toBe(1);
    // The session is in preview with a take, not still counting.
    expect(screen.getByRole("button", { name: /clone angry/i })).toBeInTheDocument();
  });

  it("does not cut a take that is still under the maximum", async () => {
    vi.useFakeTimers();
    renderRecorder();
    await recordFor(MAX_SECONDS - 1);
    expect(FakeRecorder.stopped).toBe(0);
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
  });
});

describe("GuidedRecorder — a refused microphone", () => {
  it("says what happened and what to do, rather than dying quietly", async () => {
    getUserMedia.mockRejectedValue(
      Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }),
    );
    renderRecorder();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    });

    expect(screen.getByText(/microphone unavailable — allow mic access and try again/))
      .toBeInTheDocument();
    // No phantom session: the recorder is still offering the start button, and
    // there is nothing to clone.
    expect(screen.getByRole("button", { name: /start recording/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clone angry/i })).toBeNull();
  });

  it("lets the user try again once permission is granted", async () => {
    vi.useFakeTimers();
    getUserMedia.mockRejectedValueOnce(new Error("NotAllowedError"));
    renderRecorder();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    });
    expect(screen.getByText(/microphone unavailable/)).toBeInTheDocument();

    await recordFor(MIN_SECONDS + 2);
    // The stale failure is cleared by the attempt that succeeded — a banner
    // describing a state the user is no longer in is its own lie.
    expect(screen.queryByText(/microphone unavailable/)).toBeNull();
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
  });
});

describe("GuidedRecorder — a re-record carries its defect", () => {
  it("names the measured defect in the recorder's own voice", () => {
    renderRecorder({
      defect: "clipped — move further from the mic, or lower the input gain, and record it again",
    });
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/re-recording — the last Angry take was clipped/);
    expect(banner).toHaveTextContent(/lower the input gain/);
  });

  it("is advisory, never a blocker — the session records exactly as normal", async () => {
    vi.useFakeTimers();
    const { onClone } = renderRecorder({ defect: "noisy — record somewhere quieter" });
    await recordFor(MIN_SECONDS + 2);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /stop/i })); });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /clone angry/i }));
    });
    expect(onClone).toHaveBeenCalledTimes(1);
  });

  it("says nothing about a defect on a first take", () => {
    renderRecorder();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/re-recording/)).toBeNull();
  });
});
