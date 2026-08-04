// The share page's two server-side reads. Neither throws, and their failures
// are NOT interchangeable: a missing take is a 404 page, an UNREACHABLE backend
// is an error state on a page that still exists, and a missing lineage is a
// page with no provenance strip.

import { describe, expect, it, vi } from "vitest";

const { backendFetch } = vi.hoisted(() => ({ backendFetch: vi.fn() }));
vi.mock("@/lib/backend", () => ({ backendFetch, READ_TIMEOUT_MS: 15_000 }));

import { loadLineage, loadTake } from "./takes";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("loadTake", () => {
  it("returns the take", async () => {
    backendFetch.mockResolvedValueOnce(json({ id: "abc", text: "hi" }));
    const loaded = await loadTake("abc");
    expect(loaded.status).toBe("ok");
    expect(loaded.status === "ok" && loaded.take.id).toBe("abc");
  });

  it("calls a 404 GONE — a permanent answer the visitor can act on", async () => {
    backendFetch.mockResolvedValueOnce(json({ detail: "take not found" }, 404));
    expect(await loadTake("abc")).toEqual({ status: "gone" });
  });

  it("does NOT call an unreachable backend a missing take", async () => {
    // No response at all (connection refused / the read timeout fired).
    backendFetch.mockRejectedValueOnce(new TypeError("network"));
    expect(await loadTake("abc")).toEqual({
      status: "unreachable", detail: "Gravitone backend unreachable",
    });
  });

  it("reports the backend's own detail for a server-side failure", async () => {
    backendFetch.mockResolvedValueOnce(json({ detail: "internal error [req 7f3a]" }, 500));
    expect(await loadTake("abc")).toEqual({
      status: "unreachable", detail: "internal error [req 7f3a]",
    });
  });

  it("treats an unreadable 200 body as unreachable, not as a missing take", async () => {
    backendFetch.mockResolvedValueOnce(new Response("<html>proxy error</html>", { status: 200 }));
    const loaded = await loadTake("abc");
    expect(loaded.status).toBe("unreachable");
  });

  it("names the 503 the studio's own proxy answers", async () => {
    backendFetch.mockResolvedValueOnce(new Response("service unavailable", { status: 503 }));
    expect(await loadTake("abc")).toEqual({
      status: "unreachable", detail: "Gravitone backend unreachable",
    });
  });
});

describe("loadLineage", () => {
  it("reads the chain", async () => {
    backendFetch.mockResolvedValueOnce(json({
      id: "child", ancestors: [{ id: "parent" }], children: [],
      children_total: 0, depth_capped: false,
    }));
    const lineage = await loadLineage("child");
    expect(lineage?.ancestors[0].id).toBe("parent");
  });

  it("asks the lineage endpoint, not the take endpoint", async () => {
    backendFetch.mockResolvedValueOnce(json({ id: "a b", ancestors: [], children: [] }));
    await loadLineage("a b");
    expect(backendFetch.mock.calls[0][0]).toBe("/v1/takes/a%20b/lineage");
  });

  it("degrades to null so provenance can never cost the page its take", async () => {
    backendFetch.mockResolvedValueOnce(json({ detail: "no" }, 500));
    expect(await loadLineage("abc")).toBeNull();
    backendFetch.mockRejectedValueOnce(new Error("timeout"));
    expect(await loadLineage("abc")).toBeNull();
  });
});
