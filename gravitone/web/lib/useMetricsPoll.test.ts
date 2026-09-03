import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMetricsPoll } from "./useMetricsPoll";

const SNAPSHOT = {
  config: { workers: 1 },
  metrics: { in_flight: 2, queued: 0, realtime_factor: 1.33, latency_p50_s: null },
  cache: { hits: 4 },
};

function ok(body: unknown = SNAPSHOT) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

function down() {
  return new Response(JSON.stringify({ detail: "backend unreachable" }), {
    status: 503, headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("useMetricsPoll", () => {
  it("reads once on mount and then on its interval", async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", f);
    const { result } = renderHook(() => useMetricsPoll(5_000));
    await act(async () => { await Promise.resolve(); });
    expect(f).toHaveBeenCalledTimes(1);
    expect(result.current.data?.metrics?.in_flight).toBe(2);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("keeps the last snapshot when a read fails, and marks it stale", async () => {
    // The load-bearing property: blanking the tiles would render as "zero
    // traffic" when it means "we cannot see the backend".
    vi.useFakeTimers();
    const f = vi.fn().mockResolvedValueOnce(ok()).mockResolvedValue(down());
    vi.stubGlobal("fetch", f);
    const { result } = renderHook(() => useMetricsPoll(5_000));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.stale).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(result.current.data?.metrics?.in_flight).toBe(2); // kept, not zeroed
    expect(result.current.stale).toBe(true);
    expect(result.current.failures).toBe(1);
    // apiJson's contract: a 503 reads as unreachable, not as a raw status.
    expect(result.current.error).toBeTruthy();
  });

  it("counts consecutive failures so the page can escalate", async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockResolvedValue(down());
    vi.stubGlobal("fetch", f);
    const { result } = renderHook(() => useMetricsPoll(1_000));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.failures).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result.current.failures).toBe(3);
    // Nothing ever arrived, so there is no snapshot to call stale.
    expect(result.current.data).toBeNull();
    expect(result.current.stale).toBe(false);
  });

  it("clears the failure state once a read succeeds again", async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockResolvedValueOnce(down()).mockResolvedValue(ok());
    vi.stubGlobal("fetch", f);
    const { result } = renderHook(() => useMetricsPoll(1_000));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.failures).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current.failures).toBe(0);
    expect(result.current.error).toBeNull();
    expect(result.current.stale).toBe(false);
  });

  it("preserves a null field rather than defaulting it to zero", async () => {
    // realtime_factor / the percentiles are null on an engine that has not
    // measured itself yet. A 0 here would be a fabricated measurement.
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok()));
    const { result } = renderHook(() => useMetricsPoll(5_000));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.data?.metrics?.latency_p50_s).toBeNull();
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", f);
    const { unmount } = renderHook(() => useMetricsPoll(1_000));
    await act(async () => { await Promise.resolve(); });
    expect(f).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
