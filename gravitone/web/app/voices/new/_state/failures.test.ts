// The two refusals this flow used to swallow.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANCEL_UNFINISHED, assetRefusal, cancelIngest } from "./failures";

afterEach(() => { vi.unstubAllGlobals(); });

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });

describe("assetRefusal", () => {
  it("returns the service's own sentence about a segment it will not serve", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(
      { detail: "segment 4 was measured as not the target speaker, so it is not available to any stem" },
      404)));
    expect(await assetRefusal("/api/ingest/j1/segment/4"))
      .toMatch(/measured as not the target speaker/);
  });

  it("carries the expired-session sentence too — a different fact", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(
      { status: "expired", detail: "job not found or expired" }, 404)));
    expect(await assetRefusal("/api/ingest/j1/preview/joy")).toBe("job not found or expired");
  });

  it("invents nothing when the re-request succeeds (transient failure)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("RIFF", { status: 200 })));
    expect(await assetRefusal("/api/ingest/j1/segment/1")).toBeNull();
  });

  it("invents nothing when we could not ask at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    expect(await assetRefusal("/api/ingest/j1/segment/1")).toBeNull();
  });

  it("invents nothing when the refusal carried no sentence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    expect(await assetRefusal("/api/ingest/j1/segment/1")).toBeNull();
  });
});

describe("cancelIngest", () => {
  it("is satisfied by a 404 — the job is already gone, which is what was asked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "job not found or expired" }, 404)));
    expect(await cancelIngest("j1")).toEqual({ ok: true });
  });

  it("reports the backend's refusal rather than pretending the session ended", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "this job is committing" }, 409)));
    const out = await cancelIngest("j1");
    expect(out.ok).toBe(false);
    expect(out).toHaveProperty("detail", "this job is committing");
  });

  it("reports an unreachable studio the same way", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    const out = await cancelIngest("j1");
    expect(out.ok).toBe(false);
    expect(out).toHaveProperty("detail", expect.stringMatching(/couldn't reach the studio/));
  });

  it("DELETEs the job", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    await cancelIngest("j9");
    expect(f).toHaveBeenCalledWith("/api/ingest/j9", { method: "DELETE" });
  });
});

// The copy is the fix. A rollback sentence that names the wrong state is the
// same bug as no sentence at all, so the words are pinned: it must not claim
// the clone stopped, and it must send the user where the evidence is.
it("names the state a failed cancel leaves behind", () => {
  expect(CANCEL_UNFINISHED).toMatch(/may still be finishing/);
  expect(CANCEL_UNFINISHED).toMatch(/roster/);
  expect(CANCEL_UNFINISHED).not.toMatch(/cancelled|stopped/i);
});
