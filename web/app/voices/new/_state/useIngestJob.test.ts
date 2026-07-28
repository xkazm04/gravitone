// Behaviour of the single ingest poller.
//
// What is pinned here is what the USER experiences: a job that aged out ends
// the flow instead of spinning, a flaky connection is admitted rather than
// animated over, a finished job stops costing requests, and a long step is not
// hammered at 1.5s for ten minutes. The cadence numbers themselves are an
// implementation detail — the assertions are about the shape of the ladder.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useIngestJob } from "./useIngestJob";
import type { Job } from "./machine";

function body(over: Partial<Job> = {}): string {
  return JSON.stringify({
    status: "running", step: "isolate", steps: [], partial: {},
    speakers: null, duration: 0, result: null, error: null, ...over,
  });
}

function mount(fetchImpl: ReturnType<typeof vi.fn>, jobId: string | null = "j1", enabled = true) {
  vi.stubGlobal("fetch", fetchImpl);
  const onJob = vi.fn();
  const onExpired = vi.fn();
  const onStalled = vi.fn();
  const view = renderHook(() => useIngestJob({ jobId, enabled, onJob, onExpired, onStalled }));
  return { ...view, onJob, onExpired, onStalled, fetchImpl };
}

/** Every fetch's wall-clock, so the cadence can be read off the gaps. */
function timedFetch(reply: (callIndex: number, now: number) => Response, at: number[]) {
  let i = 0;
  return vi.fn().mockImplementation(() => {
    at.push(Date.now());
    return Promise.resolve(reply(i++, Date.now()));
  });
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("useIngestJob", () => {
  it("does not poll without a job, or while disabled", async () => {
    vi.useFakeTimers();
    const a = mount(vi.fn(), null, true);
    const b = mount(vi.fn(), "j1", false);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(a.fetchImpl).not.toHaveBeenCalled();
    expect(b.fetchImpl).not.toHaveBeenCalled();
  });

  it("hands every payload to the page", async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    const { onJob } = mount(timedFetch(() => new Response(body()), at));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(onJob).toHaveBeenCalledTimes(1);
    expect(onJob.mock.calls[0][0].status).toBe("running");
  });

  it("ends the flow when the job is gone (404) and stops asking", async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    const { onJob, onExpired, fetchImpl } =
      mount(timedFetch(() => new Response("{}", { status: 404 }), at));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(onJob).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no reschedule after expiry
  });

  it("ends the flow when the server itself reports the session expired", async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    const { onExpired, fetchImpl } =
      mount(timedFetch(() => new Response(body({ status: "expired" })), at));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(onExpired).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops polling once the job reaches a terminal status", async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    const { onJob, fetchImpl } =
      mount(timedFetch(() => new Response(body({ status: "done" })), at));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(onJob).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the page owns it from here
  });

  it("never turns a 5xx body into a job, and admits the connection is degraded", async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    const { onJob, onStalled, fetchImpl } = mount(
      timedFetch(() => new Response("<html>gateway</html>", { status: 502 }), at));
    // First two failures stay quiet — a blip is not a degraded connection.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onStalled).not.toHaveBeenCalledWith(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_600); });
    expect(onStalled).toHaveBeenCalledWith(true);
    expect(onJob).not.toHaveBeenCalled();
    // …and it keeps retrying: the job is durable server-side.
    const before = fetchImpl.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(before);
  });

  it("says the same about a dead network", async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockRejectedValue(new TypeError("network"));
    const { onStalled } = mount(f);
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(onStalled).toHaveBeenCalledWith(true);
  });

  it("takes back the degraded notice as soon as a poll succeeds", async () => {
    vi.useFakeTimers();
    const f = vi.fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockRejectedValueOnce(new TypeError("network"))
      .mockRejectedValueOnce(new TypeError("network"))
      .mockImplementation(() => Promise.resolve(new Response(body())));
    const { onStalled, onJob } = mount(f);
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(onStalled).toHaveBeenCalledWith(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(onStalled).toHaveBeenLastCalledWith(false);
    expect(onJob).toHaveBeenCalled();
  });

  it("polls tightly at first and backs off as one step drags on", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const at: number[] = [];
    mount(timedFetch(() => new Response(body({ step: "isolate" })), at));
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });

    const gaps = at.slice(1).map((t, i) => t - at[i]);
    expect(at[0]).toBe(1_500);                       // first look is prompt
    expect(gaps[0]).toBe(1_500);
    // Monotonic: the cadence only ever relaxes while the step is unchanged.
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]);
    expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0]);
    // A step that runs 90s costs far fewer requests than the tight cadence.
    expect(at.length).toBeLessThan(90_000 / 1_500);
  });

  it("goes tight again the moment the server moves to a new step", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const at: number[] = [];
    // One long step, then a change once the ladder has fully relaxed.
    mount(timedFetch((_i, now) => new Response(body({ step: now < 50_000 ? "isolate" : "classify" })), at));
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    const relaxed = at.slice(1).map((t, i) => t - at[i]).pop()!;
    expect(relaxed).toBeGreaterThan(1_500);

    const before = at.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    const after = at.slice(before).map((t, i) => t - (i === 0 ? at[before - 1] : at[before + i - 1]));
    expect(Math.min(...after)).toBe(1_500);
  });

  it("stops on unmount", async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    const { unmount, fetchImpl } = mount(timedFetch(() => new Response(body()), at));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
