// Public re-perform on a share page. Three properties are load-bearing:
// the panel does not exist unless the PUBLISHER opted in, every refusal the
// service names reaches the visitor verbatim (a 429 with the wait included),
// and a success links to the CHILD take rather than pretending in place.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import RePerform, { MAX_REPERFORM_TEXT, ReperformProvenance } from "./RePerform";
import type { SharedTake } from "@/lib/takes";

const TAKE: SharedTake = {
  id: "take123abc", character_id: "sarah", character_name: "Sarah",
  text: "[angry] You said you would call.", seconds: 2, rtf: 0.2,
  segments: [], created: "2026-07-30T10:00:00+00:00",
  allow_reperform: true,
};

const button = () => screen.queryByRole("button", { name: /render this take/i });
const field = () => screen.getByLabelText(/text to re-perform/i) as HTMLTextAreaElement;

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const f = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers }));
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("RePerform — the publisher's consent gates the whole panel", () => {
  it("renders nothing for a take published without the opt-in", () => {
    const { container } = render(<RePerform take={{ ...TAKE, allow_reperform: false }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a take published before the flag existed", () => {
    const { allow_reperform: _drop, ...legacy } = TAKE;
    const { container } = render(<RePerform take={legacy as SharedTake} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers the field pre-filled with the take's own metatagged text", () => {
    render(<RePerform take={TAKE} />);
    expect(field().value).toBe(TAKE.text);
    expect(button()).toBeEnabled();
  });

  // The budget is per ADDRESS, and on a default deploy every visitor reaches
  // the service through this studio's own server — so it is one budget for the
  // whole audience, not "a few tries per visitor". Copy that promises what the
  // shipped deployment cannot give is the same bug as no copy at all.
  it("promises a SHARED budget, not a per-visitor allowance", () => {
    render(<RePerform take={TAKE} />);
    expect(screen.getByText(/shared with everyone else here/i)).toBeInTheDocument();
    expect(screen.queryByText(/per visitor/i)).not.toBeInTheDocument();
  });
});

describe("RePerform — rendering", () => {
  it("posts the edited text and links to the child take", async () => {
    const f = answer(201, { take_id: "child00001", parent_id: TAKE.id });
    render(<RePerform take={TAKE} />);
    fireEvent.change(field(), { target: { value: "[sad] You never called." } });
    fireEvent.click(button()!);

    await waitFor(() => expect(screen.getByRole("link", { name: /open your version/i }))
      .toHaveAttribute("href", "/t/child00001"));
    expect(f).toHaveBeenCalledWith("/t/take123abc/reperform", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ text: "[sad] You never called." }),
    }));
  });

  it("shows the service's named refusal verbatim", async () => {
    answer(403, { detail: "not-published-for-reperform: whoever published this take did not open it" });
    render(<RePerform take={TAKE} />);
    fireEvent.click(button()!);
    expect(await screen.findByRole("alert"))
      .toHaveTextContent(/not-published-for-reperform/);
  });

  it("tells a rate-limited visitor how long to wait", async () => {
    answer(429, { detail: "rate-limited: the 'reperform' budget is 5 request(s) per 300s" },
           { "Retry-After": "212" });
    render(<RePerform take={TAKE} />);
    fireEvent.click(button()!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/rate-limited/);
    expect(alert).toHaveTextContent(/Try again in 212s/);
  });

  it("says the studio is unreachable rather than nothing when the post throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(<RePerform take={TAKE} />);
    fireEvent.click(button()!);
    expect(await screen.findByRole("alert")).toHaveTextContent(/offline/);
  });

  it("refuses over-long text locally, before spending a budgeted request", () => {
    const f = answer(201, { take_id: "child00001" });
    render(<RePerform take={TAKE} />);
    fireEvent.change(field(), { target: { value: "x".repeat(MAX_REPERFORM_TEXT + 1) } });
    expect(button()).toBeDisabled();
    fireEvent.click(button()!);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses an empty field", () => {
    render(<RePerform take={TAKE} />);
    fireEvent.change(field(), { target: { value: "   " } });
    expect(button()).toBeDisabled();
  });
});

describe("ReperformProvenance", () => {
  it("marks a visitor-rendered take on its own page", () => {
    render(<ReperformProvenance take={{ ...TAKE, derived_from: { kind: "public-reperform" } }} />);
    expect(screen.getByText(/Re-performed by a visitor/)).toBeInTheDocument();
  });

  it("says nothing about a take the studio itself published", () => {
    const { container } = render(
      <ReperformProvenance take={{ ...TAKE, derived_from: { kind: "remix" } }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
