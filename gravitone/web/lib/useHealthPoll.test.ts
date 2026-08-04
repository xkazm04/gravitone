import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useHealthPoll } from "./useHealthPoll";

function healthFetch() {
  return vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ status: "ready" }), { status: 200 })));
}

/** Drive document.hidden, which jsdom reports as a fixed false. */
function visibility(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

describe("useHealthPoll", () => {
  it("polls once on mount and then on its interval", async () => {
    vi.useFakeTimers();
    const f = healthFetch();
    vi.stubGlobal("fetch", f);
    renderHook(() => useHealthPoll(30_000));
    await act(async () => { await Promise.resolve(); });
    expect(f).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("changing the cadence does not fire an extra request", async () => {
    // The playground speeds the poller up while it renders. Re-arming the whole
    // effect on that change cost one extra /api/health per generate.
    vi.useFakeTimers();
    const f = healthFetch();
    vi.stubGlobal("fetch", f);
    const { rerender } = renderHook(({ ms }) => useHealthPoll(ms), {
      initialProps: { ms: 30_000 },
    });
    await act(async () => { await Promise.resolve(); });
    expect(f).toHaveBeenCalledTimes(1);
    await act(async () => { rerender({ ms: 5_000 }); });
    expect(f).toHaveBeenCalledTimes(1);
    // …but the faster cadence takes effect immediately rather than waiting out
    // the old 30s window.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("marks the snapshot stale instead of blanking it when the backend cannot be reached", async () => {
    vi.useFakeTimers();
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ready" }), { status: 200 }))
      .mockRejectedValue(new TypeError("network"));
    vi.stubGlobal("fetch", f);
    const { result } = renderHook(() => useHealthPoll(1_000));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.health?.status).toBe("ready");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current.stale).toBe(true);
    expect(result.current.health?.status).toBe("ready"); // last snapshot kept
  });

  // A self-scheduling loop with no visibility handling is a tab left open
  // overnight polling a CPU box every five seconds.
  it("stops polling while the tab is hidden", async () => {
    vi.useFakeTimers();
    const f = healthFetch();
    vi.stubGlobal("fetch", f);
    renderHook(() => useHealthPoll(1_000));
    await act(async () => { await Promise.resolve(); });
    expect(f).toHaveBeenCalledTimes(1);

    await act(async () => { visibility(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(f).toHaveBeenCalledTimes(1); // a whole minute, and not one request
  });

  it("polls immediately when the tab comes back, not on the next interval", async () => {
    vi.useFakeTimers();
    const f = healthFetch();
    vi.stubGlobal("fetch", f);
    renderHook(() => useHealthPoll(30_000));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { visibility(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(f).toHaveBeenCalledTimes(1);

    await act(async () => { visibility(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // The number on screen is two minutes old; it is refreshed now, not in 30s.
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not poll at all when it mounts into a hidden tab", async () => {
    vi.useFakeTimers();
    const f = healthFetch();
    vi.stubGlobal("fetch", f);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    renderHook(() => useHealthPoll(1_000));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(f).not.toHaveBeenCalled();
    await act(async () => { visibility(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
