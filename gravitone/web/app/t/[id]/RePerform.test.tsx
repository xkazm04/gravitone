// Public re-perform on a share page. Three properties are load-bearing:
// the panel does not exist unless the PUBLISHER opted in, every refusal the
// service names reaches the visitor verbatim (a 429 with the wait included),
// and a success links to the CHILD take rather than pretending in place.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import RePerform, {
  castLines, MAX_REPERFORM_LINES, MAX_REPERFORM_TEXT, ReperformProvenance,
} from "./RePerform";
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
    // findByText, not findByRole("alert"): the panel already carries a
    // standing warning for a take that names no cast, so "the alert" is no
    // longer a unique thing to assert on.
    expect(await screen.findByText(/not-published-for-reperform/)).toBeInTheDocument();
  });

  it("tells a rate-limited visitor how long to wait", async () => {
    answer(429, { detail: "rate-limited: the 'reperform' budget is 5 request(s) per 300s" },
           { "Retry-After": "212" });
    render(<RePerform take={TAKE} />);
    fireEvent.click(button()!);
    const alert = await screen.findByText(/rate-limited/);
    expect(alert).toHaveTextContent(/Try again in 212s/);
  });

  it("says the studio is unreachable rather than nothing when the post throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(<RePerform take={TAKE} />);
    fireEvent.click(button()!);
    expect(await screen.findByText(/offline/)).toBeInTheDocument();
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

// ── the cast ────────────────────────────────────────────────────────────────
// This panel used to promise "a new version in the same voice" for every take,
// and the service then rendered a whole published ensemble in its first
// speaker's voice with no notice on the page or in the response.

const ENSEMBLE: SharedTake = {
  ...TAKE,
  text: "Sarah: you said you would call · Malik: I know",
  segments: [
    { text: "you said you would call", requested: "angry", used: "angry",
      fallback: false, seconds: 2, character_id: "sarah", character_name: "Sarah" },
    { text: "I know", requested: "baseline", used: "baseline",
      fallback: false, seconds: 1, character_id: "malik", character_name: "Malik" },
  ],
};

describe("castLines — the turns a visitor may edit", () => {
  it("is empty for a take that names fewer than two speakers", () => {
    expect(castLines(TAKE)).toEqual([]);
    expect(castLines({ ...TAKE, segments: [ENSEMBLE.segments[0]] })).toEqual([]);
  });

  it("re-emits the tags the segments were compiled from", () => {
    expect(castLines(ENSEMBLE)).toEqual([
      { characterId: "sarah", name: "Sarah", text: "[angry]you said you would call[/angry]" },
      { characterId: "malik", name: "Malik", text: "I know" },
    ]);
  });

  it("merges a Character's consecutive segments into ONE turn", () => {
    const merged = castLines({ ...ENSEMBLE, segments: [
      ...ENSEMBLE.segments,
      { text: "well?", requested: "baseline", used: "baseline", fallback: false,
        seconds: 1, character_id: "malik", character_name: "Malik" },
    ] });
    expect(merged).toHaveLength(2);
    expect(merged[1].text).toBe("I know well?");
  });
});

describe("RePerform — a cast take is re-performed as a cast", () => {
  it("offers one field per turn, labelled with its Character", () => {
    render(<RePerform take={ENSEMBLE} />);
    expect((screen.getByLabelText("Sarah") as HTMLTextAreaElement).value)
      .toBe("[angry]you said you would call[/angry]");
    expect((screen.getByLabelText("Malik") as HTMLTextAreaElement).value).toBe("I know");
    expect(screen.getByText(/a cast of 2 voices/)).toBeInTheDocument();
  });

  it("posts LINES, each addressed to its own Character", async () => {
    const f = answer(201, { take_id: "child00001", single_voice: false, notice: null });
    render(<RePerform take={ENSEMBLE} />);
    fireEvent.change(screen.getByLabelText("Malik"), { target: { value: "I meant to." } });
    fireEvent.click(button()!);

    await waitFor(() => expect(screen.getByRole("link", { name: /open your version/i }))
      .toBeInTheDocument());
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({
      lines: [
        { character_id: "sarah", text: "[angry]you said you would call[/angry]" },
        { character_id: "malik", text: "I meant to." },
      ],
    });
  });

  it("counts the character budget over the WHOLE cast, not per line", () => {
    const f = answer(201, { take_id: "c" });
    render(<RePerform take={ENSEMBLE} />);
    const half = "x".repeat(MAX_REPERFORM_TEXT / 2 + 10);
    fireEvent.change(screen.getByLabelText("Sarah"), { target: { value: half } });
    fireEvent.change(screen.getByLabelText("Malik"), { target: { value: half } });
    expect(button()).toBeDisabled();
    fireEvent.click(button()!);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a scene with more turns than a public fork may have", () => {
    const many = Array.from({ length: MAX_REPERFORM_LINES + 1 }, (_, i) => ({
      text: `line ${i}`, requested: "baseline", used: "baseline", fallback: false,
      seconds: 1, character_id: i % 2 ? "sarah" : "malik",
      character_name: i % 2 ? "Sarah" : "Malik",
    }));
    render(<RePerform take={{ ...ENSEMBLE, segments: many }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/capped at 12/);
    expect(button()).toBeDisabled();
  });
});

describe("RePerform — a take with no cast says so instead of implying one", () => {
  it("warns up front that the render is one voice and the cast is unknown", () => {
    render(<RePerform take={TAKE} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/renders as ONE voice — Sarah/);
    expect(screen.getByRole("alert")).toHaveTextContent(/not preserved/);
  });

  it("shows the service's own notice after the render", async () => {
    answer(201, {
      take_id: "child00001", single_voice: true,
      notice: "This take names no per-line cast, so the whole re-performance was rendered in one voice (Sarah).",
    });
    render(<RePerform take={TAKE} />);
    fireEvent.click(button()!);
    await waitFor(() => expect(screen.getByText(/names no per-line cast/)).toBeInTheDocument());
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
