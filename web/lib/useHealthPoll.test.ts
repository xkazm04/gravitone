import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useHealthPoll } from "./useHealthPoll";

function healthFetch() {
  return vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ status: "ready" }), { status: 200 })));
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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
});
