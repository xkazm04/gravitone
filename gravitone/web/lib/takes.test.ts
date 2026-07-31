// The share page's two server-side reads. Both degrade to null rather than
// throwing, and the two failures are NOT the same: a missing take is a 404
// page, a missing lineage is a page with no provenance strip.

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
    expect((await loadTake("abc"))?.id).toBe("abc");
  });

  it("is null for a missing/evicted take and for an unreachable backend", async () => {
    backendFetch.mockResolvedValueOnce(json({ detail: "gone" }, 404));
    expect(await loadTake("abc")).toBeNull();
    backendFetch.mockRejectedValueOnce(new TypeError("network"));
    expect(await loadTake("abc")).toBeNull();
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
