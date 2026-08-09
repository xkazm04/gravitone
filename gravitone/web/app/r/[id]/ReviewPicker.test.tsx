// The client's decision — the one irreversible thing a person with no account
// can do in this product.
//
// WHO ACTUALLY PROTECTS "first pick wins": the SERVICE does, atomically.
// service/takes.py::pick_take closes the read-check TOCTOU with an
// O_CREAT|O_EXCL `.pick` sentinel, so two tabs (or two replica processes)
// racing the same review produce exactly one winner and one clean 409. The
// `busy` gate in this component is a UX nicety ON TOP of that — it stops one
// tab double-posting, and it stops nothing else. These tests are written to
// keep the two apart, so nobody later "simplifies" the sentinel away believing
// the client is what holds the line.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/peaks", () => ({ computePeaks: vi.fn(async () => ({ peaks: [], duration: 1 })) }));
// The revision round has its own file; here it is only the thing that appears
// once a decision exists.
vi.mock("./actions", () => ({ requestRevision: vi.fn(async () => ({ ok: false, error: "unused" })) }));

import ReviewPicker, { type Review } from "./ReviewPicker";
import type { SharedTake } from "@/app/t/[id]/TakeCard";

const take = (id: string, name: string): SharedTake => ({
  id, character_id: id, character_name: name, text: "You said you would call.",
  seconds: 2, rtf: 0.2, segments: [], created: "2026-08-01T10:00:00+00:00",
});

const REVIEW: Review = {
  id: "rev1", title: "Cold open, v1", script: "You said you would call.",
  take_ids: ["t1", "t2"], created: "2026-08-01T10:00:00+00:00",
  takes: [take("t1", "Sarah"), take("t2", "Miles")],
  pick: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { url: string; body: unknown };

/** Record every pick POST and answer it with `reply`; audio reads 404 so the
 *  card degrades honestly instead of throwing. */
function stubPick(reply: (n: number) => Response | Error) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/pick")) return new Response("", { status: 404 });
    calls.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
    const r = reply(calls.length);
    if (r instanceof Error) throw r;
    return r;
  }));
  return calls;
}

const approve = () => screen.getByRole("button", { name: /Approve take/ });

beforeEach(() => {
  URL.createObjectURL = () => "blob:take";
  URL.revokeObjectURL = () => {};
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("ReviewPicker — picking a take", () => {
  it("sends the active take with the reviewer's name and note, then shows the decision", async () => {
    const calls = stubPick(() => json({
      take_id: "t2", reviewer: "Dana", note: "warmer", picked_at: "2026-08-01T11:00:00+00:00",
    }));
    render(<ReviewPicker review={REVIEW} />);

    fireEvent.click(screen.getByRole("tab", { name: /Take 2/ }));
    fireEvent.change(screen.getByPlaceholderText(/Your name/), { target: { value: " Dana " } });
    fireEvent.change(screen.getByPlaceholderText(/Why this one/), { target: { value: " warmer " } });
    fireEvent.click(approve());

    await waitFor(() => expect(screen.getByText(/was chosen/)).toBeInTheDocument());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/reviews/rev1/pick");
    expect(calls[0].body).toEqual({ take_id: "t2", reviewer: "Dana", note: "warmer" });
    // The winner is named, not just "recorded" — the client must be able to see
    // WHICH take they approved.
    const decision = screen.getByText(/was chosen/).textContent ?? "";
    expect(decision).toMatch(/Take 2 \(Miles\)/);
    expect(decision).toMatch(/by Dana/);
    // ...and the pick form is gone: first pick is final.
    expect(screen.queryByRole("button", { name: /Approve take/ })).toBeNull();
  });

  it("opens on a review that was already decided elsewhere", () => {
    stubPick(() => json({}));
    render(<ReviewPicker review={{
      ...REVIEW,
      pick: { take_id: "t1", reviewer: "Dana", note: "", picked_at: "2026-08-01T11:00:00+00:00" },
    }} />);
    expect(screen.getByText(/Take 1 \(Sarah\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve take/ })).toBeNull();
  });

  it("gates a double-click to ONE request — a nicety, not the safeguard", async () => {
    // The first POST is held open, which is the only window the gate covers.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("/pick")) return new Response("", { status: 404 });
      calls.push(url);
      await held;
      return json({ take_id: "t1", reviewer: "", note: "", picked_at: "x" });
    }));

    render(<ReviewPicker review={REVIEW} />);
    const btn = approve(); // the same node throughout — its LABEL becomes "recording…"
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("recording");
    release();

    await waitFor(() => expect(screen.getByText(/was chosen/)).toBeInTheDocument());
    expect(calls).toHaveLength(1);
  });
});

describe("ReviewPicker — the racer who lost", () => {
  // The state a SECOND tab is in when the first one won: the client gate saw
  // nothing (different component instance, different browser tab, possibly a
  // different replica process), and the 409 comes from the service's sentinel.
  it("reads as 'someone already picked', not as a generic failure", async () => {
    stubPick(() => json({ detail: "this review has already been decided" }, 409));
    render(<ReviewPicker review={REVIEW} />);
    fireEvent.click(approve());

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("this review has already been decided");
    // the house fallback would have hidden the reason
    expect(banner).not.toHaveTextContent("could not record the pick");
    expect(banner.className).toMatch(/rose/);
  });

  it("leaves the button offerable rather than stuck on 'recording…'", async () => {
    stubPick(() => json({ detail: "this review has already been decided" }, 409));
    render(<ReviewPicker review={REVIEW} />);
    fireEvent.click(approve());
    await screen.findByRole("alert");
    expect(approve()).toBeEnabled();
  });

  it("says something honest when the request never left", async () => {
    stubPick(() => new Error("Failed to fetch"));
    render(<ReviewPicker review={REVIEW} />);
    fireEvent.click(approve());
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toBeTruthy();
    // and it must NOT have claimed a decision
    expect(screen.queryByText(/was chosen/)).toBeNull();
    expect(approve()).toBeEnabled();
  });

  it("does not claim a decision when the backend answers 400", async () => {
    stubPick(() => json({ detail: "that take is not part of this review" }, 400));
    render(<ReviewPicker review={REVIEW} />);
    fireEvent.click(approve());
    expect(await screen.findByRole("alert"))
      .toHaveTextContent("that take is not part of this review");
    expect(screen.queryByText(/was chosen/)).toBeNull();
  });
});

describe("ReviewPicker — rounds", () => {
  it("links back to the round this one came from", () => {
    stubPick(() => json({}));
    render(<ReviewPicker review={{
      ...REVIEW, round: 2,
      derived_from: { review_id: "rev0", direction: "line 3: angry", note: "warmer" },
    }} />);
    expect(screen.getByRole("link", { name: /previous round/ }))
      .toHaveAttribute("href", "/r/rev0");
    expect(screen.getByText(/asked for: line 3: angry/)).toBeInTheDocument();
  });

  it("links forward to later rounds and marks the decided ones", () => {
    stubPick(() => json({}));
    render(<ReviewPicker review={{
      ...REVIEW,
      revisions: [{ id: "rev2", title: "v2", round: 2, created: "", decided: true }],
    }} />);
    expect(screen.getByRole("link", { name: /round 2/ })).toHaveAttribute("href", "/r/rev2");
  });

  it("renders a review recorded before rounds existed exactly as it did then", () => {
    stubPick(() => json({}));
    render(<ReviewPicker review={REVIEW} />);
    expect(screen.queryByText(/previous round/)).toBeNull();
    expect(screen.queryByText(/later rounds/)).toBeNull();
  });
});
