import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCopyFeedback } from "./useCopyFeedback";

function stubClipboard(impl: () => Promise<void>) {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(impl) } });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("useCopyFeedback", () => {
  it("reports copied, then clears itself", async () => {
    stubClipboard(async () => {});
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => { await result.current.copy("hello"); });
    expect(result.current.copied).not.toBeNull();
    expect(result.current.failed).toBeNull();

    act(() => { vi.advanceTimersByTime(1500); });
    expect(result.current.copied).toBeNull();
  });

  it("reports FAILED when the clipboard refuses — never 'copied'", async () => {
    // A denied permission (or an insecure context) used to still render
    // "✓ copied". The label must not claim something that didn't happen.
    stubClipboard(async () => { throw new Error("denied"); });
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => { await result.current.copy("hello"); });
    expect(result.current.copied).toBeNull();
    expect(result.current.failed).not.toBeNull();
  });

  it("tracks which target was copied", async () => {
    stubClipboard(async () => {});
    const { result } = renderHook(() => useCopyFeedback<"link" | "embed">());
    await act(async () => { await result.current.copy("x", "embed"); });
    expect(result.current.copied).toBe("embed");
  });

  it("reset() drops the indicator immediately", async () => {
    stubClipboard(async () => {});
    const { result } = renderHook(() => useCopyFeedback());
    await act(async () => { await result.current.copy("x"); });
    act(() => { result.current.reset(); });
    expect(result.current.copied).toBeNull();
  });

  it("clears its timer on unmount (no setState on a dead component)", async () => {
    stubClipboard(async () => {});
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const { result, unmount } = renderHook(() => useCopyFeedback());
    await act(async () => { await result.current.copy("x"); });
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    // Nothing pending should fire after teardown.
    act(() => { vi.advanceTimersByTime(5000); });
  });
});
