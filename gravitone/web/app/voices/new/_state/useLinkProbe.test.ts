// The paste-time verdict.
//
// What is pinned here is what the USER experiences: typing a URL costs one
// probe rather than one per keystroke, an answer for a link they have already
// edited never overwrites the one on screen, a link that cannot be read says so
// (with the backend's own sentence) instead of spinning, and a backend that is
// down is reported as a backend that is down — not as a bad video.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { PROBE_DEBOUNCE_MS, looksLikeUrl, useLinkProbe } from "./useLinkProbe";

const OK = {
  ok: true, title: "A talk", duration: 2820, clip_seconds: 900,
  trimmed: true, message: "47 minutes video — we'll clone the first 15 minutes.",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("looksLikeUrl", () => {
  it("only spends a round-trip on something shaped like a link", () => {
    expect(looksLikeUrl("https://youtu.be/abc")).toBe(true);
    expect(looksLikeUrl("  https://www.youtube.com/watch?v=x ")).toBe(true);
    expect(looksLikeUrl("youtube")).toBe(false);
    expect(looksLikeUrl("https://")).toBe(false);
    expect(looksLikeUrl("")).toBe(false);
  });
});

describe("useLinkProbe", () => {
  it("stays idle while disabled or while the box holds no link", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const a = renderHook(() => useLinkProbe("https://youtu.be/a", false));
    const b = renderHook(() => useLinkProbe("not a url", true));
    await new Promise((r) => setTimeout(r, PROBE_DEBOUNCE_MS + 50));
    expect(f).not.toHaveBeenCalled();
    expect(a.result.current.status).toBe("idle");
    expect(b.result.current.status).toBe("idle");
  });

  it("asks once and carries the verdict, including the trim sentence", async () => {
    const f = vi.fn().mockResolvedValue(json(OK));
    vi.stubGlobal("fetch", f);
    const { result } = renderHook(() => useLinkProbe("https://youtu.be/abc", true));
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe("/api/ingest/link-probe");
    expect(JSON.parse(String(f.mock.calls[0][1].body))).toEqual({
      url: "https://youtu.be/abc",
    });
    if (result.current.status !== "done") throw new Error("unreachable");
    expect(result.current.verdict.trimmed).toBe(true);
    expect(result.current.verdict.message).toContain("first 15 minutes");
  });

  it("does not probe every keystroke", async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockResolvedValue(json(OK));
    vi.stubGlobal("fetch", f);
    const { rerender } = renderHook(({ u }) => useLinkProbe(u, true), {
      initialProps: { u: "https://youtu.be/a" },
    });
    for (const u of ["https://youtu.be/ab", "https://youtu.be/abc"]) {
      await act(async () => { rerender({ u }); await vi.advanceTimersByTimeAsync(100); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(PROBE_DEBOUNCE_MS + 50); });
    expect(f).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(f.mock.calls[0][1].body)).url).toBe("https://youtu.be/abc");
  });

  it("never lets a stale answer overwrite the link now in the box", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((r: Response) => void) | null = null;
    const f = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((res) => { resolveFirst = res; }))
      .mockResolvedValue(json({ ...OK, title: "The second one", trimmed: false }));
    vi.stubGlobal("fetch", f);
    const { result, rerender } = renderHook(({ u }) => useLinkProbe(u, true), {
      initialProps: { u: "https://youtu.be/first" },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(PROBE_DEBOUNCE_MS + 10); });
    await act(async () => {
      rerender({ u: "https://youtu.be/second" });
      await vi.advanceTimersByTimeAsync(PROBE_DEBOUNCE_MS + 10);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    // The first request answers LAST, for a link the user has moved on from.
    await act(async () => {
      resolveFirst?.(json({ ...OK, title: "The stale one" }));
      await vi.advanceTimersByTimeAsync(2000);
    });
    if (result.current.status !== "done") throw new Error("expected a verdict");
    expect(result.current.verdict.title).toBe("The second one");
  });

  it("reports a refused link with the backend's own sentence", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      json({ detail: "that video is private. Download the audio and drop the file instead." }, 422)));
    const { result } = renderHook(() => useLinkProbe("https://youtu.be/abc", true));
    await waitFor(() => expect(result.current.status).toBe("failed"));
    if (result.current.status !== "failed") throw new Error("unreachable");
    expect(result.current.detail).toContain("private");
    expect(result.current.detail).toContain("drop the file");
  });

  it("says the backend is unreachable rather than blaming the video", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const { result } = renderHook(() => useLinkProbe("https://youtu.be/abc", true));
    await waitFor(() => expect(result.current.status).toBe("failed"));
    if (result.current.status !== "failed") throw new Error("unreachable");
    expect(result.current.detail).toContain("backend");
  });

  it("clears the verdict when the box is emptied", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(OK)));
    const { result, rerender } = renderHook(({ u }) => useLinkProbe(u, true), {
      initialProps: { u: "https://youtu.be/abc" },
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    await act(async () => { rerender({ u: "" }); });
    expect(result.current.status).toBe("idle");
  });
});
