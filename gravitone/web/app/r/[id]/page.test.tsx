// The review link's two failures, which are NOT the same failure.
//
// This route mapped every fetch failure — connection refused, 5xx, timeout — to
// one null and 404'd it, so a client opening the link during a backend restart
// was told the link was dead. Its sibling at /t/[id] refuses to tell exactly
// that lie; these tests pin the same distinction here, in the same vocabulary,
// on the page where it costs the sender their client's trust.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
// The waveform needs a real AudioContext; nothing here is asserting decoration.
vi.mock("@/lib/peaks", () => ({ computePeaks: vi.fn(async () => ({ peaks: [], duration: 1 })) }));

import ReviewPage, { generateMetadata, loadReview } from "./page";
import type { Review } from "./ReviewPicker";

const REVIEW: Review = {
  id: "rev1",
  title: "Cold open, v1",
  script: "You said you would call.",
  take_ids: ["t1"],
  created: "2026-08-01T10:00:00+00:00",
  takes: [{
    id: "t1", character_id: "sarah", character_name: "Sarah",
    text: "[angry] You said you would call.", seconds: 2, rtf: 0.2,
    segments: [], created: "2026-08-01T10:00:00+00:00",
  }],
  pick: null,
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...headers },
  });

/** Answer the review read with `reply`; every other request (the card's audio)
 *  gets a benign 404 so the take card degrades instead of throwing. */
function stubBackend(reply: () => Response | Error) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/v1/reviews/")) return new Response("", { status: 404 });
    const r = reply();
    if (r instanceof Error) throw r;
    return r;
  }));
}

const page = () => ReviewPage({ params: Promise.resolve({ id: "rev1" }) });
const meta = () => generateMetadata({ params: Promise.resolve({ id: "rev1" }) });

beforeEach(() => {
  URL.createObjectURL = () => "blob:take-1";
  URL.revokeObjectURL = () => {};
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("loadReview — which failure was it", () => {
  it("reads a review the backend has", async () => {
    stubBackend(() => json(REVIEW));
    expect(await loadReview("rev1")).toEqual({ status: "ok", review: REVIEW });
  });

  it("calls a 404 gone — permanently", async () => {
    stubBackend(() => json({ detail: "no such review" }, 404));
    expect(await loadReview("rev1")).toEqual({ status: "gone" });
  });

  it("calls a refused connection unreachable, not gone", async () => {
    stubBackend(() => new Error("ECONNREFUSED"));
    expect(await loadReview("rev1")).toEqual({
      status: "unreachable", detail: "Gravitone backend unreachable",
    });
  });

  it("keeps the backend's own sentence for a 5xx", async () => {
    stubBackend(() => json({ detail: "request 7f3a failed" }, 500));
    expect(await loadReview("rev1")).toEqual({
      status: "unreachable", detail: "request 7f3a failed",
    });
  });

  it("reads a 503 as the one unreachable sentence the studio uses everywhere", async () => {
    stubBackend(() => new Response("<html>gateway</html>", { status: 503 }));
    expect(await loadReview("rev1")).toEqual({
      status: "unreachable", detail: "Gravitone backend unreachable",
    });
  });

  it("treats a 200 that is not JSON as a broken backend, not a missing review", async () => {
    stubBackend(() => new Response("not json", { status: 200 }));
    const loaded = await loadReview("rev1");
    expect(loaded.status).toBe("unreachable");
  });
});

describe("ReviewPage — gone vs unreachable", () => {
  it("404s a review that genuinely is not there", async () => {
    stubBackend(() => json({ detail: "no such review" }, 404));
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s a review with nothing to listen to", async () => {
    stubBackend(() => json({ ...REVIEW, takes: [], take_ids: [] }));
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("does NOT 404 an unreachable backend — it says the link is still good", async () => {
    stubBackend(() => new Error("ECONNREFUSED"));
    render(await page());

    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("Gravitone backend unreachable");
    expect(banner).toHaveTextContent(/the review link is still valid/i);
    // rose, not amber: this is a failed read, not a caveat.
    expect(banner.className).toMatch(/rose/);
    // and it must not imply the sender withdrew anything
    expect(screen.getByText(/Nothing has been withdrawn/i)).toBeInTheDocument();
    // The 404 vocabulary must not appear at all — the sentence about a
    // cancelled review is a DENIAL of one, and reads as such.
    expect(document.body.textContent).not.toMatch(/not found/i);
    expect(document.body.textContent).toMatch(/is not a cancelled review/i);
  });

  it("renders the picker when the backend answers", async () => {
    stubBackend(() => json(REVIEW));
    render(await page());
    expect(screen.getByRole("heading", { name: "Cold open, v1" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ReviewPage metadata — a crawler is told the same truth", () => {
  it("says not found only when it IS not found", async () => {
    stubBackend(() => json({ detail: "no such review" }, 404));
    expect((await meta()).title).toBe("Review not found — Gravitone");
  });

  it("says temporarily unavailable when the box is not answering", async () => {
    stubBackend(() => new Error("ECONNREFUSED"));
    expect((await meta()).title).toBe("Review temporarily unavailable — Gravitone");
  });

  it("never offers client work to the index", async () => {
    stubBackend(() => json(REVIEW));
    const m = await meta();
    expect(m.title).toBe("Cold open, v1 — pick a take");
    expect(m.robots).toEqual({ index: false });
  });
});
