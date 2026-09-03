import { describe, expect, it, vi, afterEach } from "vitest";
import { ApiError, apiJson, readDetail, throwDetail } from "./apiFetch";

function res(body: unknown, init: ResponseInit = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status: 200, ...init });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("readDetail", () => {
  it("extracts the backend's detail", async () => {
    expect(await readDetail(res({ detail: "clip too short" }))).toBe("clip too short");
  });

  it("returns undefined for a non-JSON body instead of throwing", async () => {
    // The bug this guards: an unguarded r.json() on a plain-text proxy error
    // surfaced a raw SyntaxError to the user in the voice-create flow.
    expect(await readDetail(res("backend unreachable"))).toBeUndefined();
  });

  it("ignores a non-string detail", async () => {
    expect(await readDetail(res({ detail: { nested: true } }))).toBeUndefined();
  });
});

describe("throwDetail", () => {
  it("prefers the backend detail and keeps the status", async () => {
    await expect(throwDetail(res({ detail: "nope" }, { status: 409 }), "fallback"))
      .rejects.toMatchObject({ message: "nope", status: 409 });
  });

  it("always says 'unreachable' for a 503, whatever the body", async () => {
    await expect(throwDetail(res("", { status: 503 }), "fallback"))
      .rejects.toThrow("Gravitone backend unreachable");
  });

  it("falls back when there is no detail", async () => {
    await expect(throwDetail(res({}, { status: 500 }), "clone failed"))
      .rejects.toThrow("clone failed");
  });

  it("throws an ApiError so callers can branch on status", async () => {
    await expect(throwDetail(res({}, { status: 429 }), "busy"))
      .rejects.toBeInstanceOf(ApiError);
  });
});

describe("apiJson", () => {
  it("returns parsed JSON on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res([{ id: "a" }])));
    await expect(apiJson<{ id: string }[]>("/api/x", undefined, "boom"))
      .resolves.toEqual([{ id: "a" }]);
  });

  it("throws — never resolves to an empty list — when the request fails", async () => {
    // Erasing a 500 into [] is what made a down backend look like an empty
    // character roster.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res({ detail: "upstream" }, { status: 500 })));
    await expect(apiJson("/api/x", undefined, "could not load")).rejects.toThrow("upstream");
  });
});
