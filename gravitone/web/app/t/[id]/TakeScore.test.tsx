import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import TakeScore, { hasScore, laneSegments, placeSegments } from "./TakeScore";
import type { SharedTake } from "@/lib/takes";

const seg = (over: Partial<SharedTake["segments"][number]>): SharedTake["segments"][number] => ({
  text: "hello", requested: "baseline", used: "baseline", fallback: false, seconds: 1, ...over,
});

const TAKE: SharedTake = {
  id: "t1",
  character_id: "sarah",
  character_name: "Sarah",
  text: "one two",
  seconds: 4,
  rtf: 1,
  created: "",
  segments: [
    seg({ text: "one", used: "baseline", requested: "baseline", seconds: 1 }),
    seg({ text: "two", used: "calm", requested: "whisper", fallback: true, seconds: 3 }),
  ],
};

const mount = (take: SharedTake = TAKE) => render(<TakeScore take={take} />);

describe("placeSegments — the same timing rule as the studio", () => {
  it("scales reported seconds so the last span ends at the duration", () => {
    const { spans, even } = placeSegments(TAKE.segments, 4);
    expect(even).toBe(false);
    expect(spans.map((s) => [s.start, s.end])).toEqual([[0, 1], [1, 4]]);
  });

  it("spaces evenly, and says so, when the take reported no per-segment timing", () => {
    const { spans, even } = placeSegments([seg({ seconds: 0 }), seg({ seconds: 0 })], 10);
    expect(even).toBe(true);
    expect(spans.map((s) => s.end)).toEqual([5, 10]);
  });

  it("places nothing without segments or without a duration", () => {
    expect(placeSegments([], 10).spans).toEqual([]);
    expect(placeSegments(TAKE.segments, 0).spans).toEqual([]);
  });
});

describe("TakeScore — the shared take, read-only", () => {
  it("draws one span per segment, placed in TIME", () => {
    mount();
    expect(screen.getByRole("button", { name: /Region 1 of 2/ })).toHaveAccessibleName(/0:00 to 0:01/);
    expect(screen.getByRole("button", { name: /Region 2 of 2/ })).toHaveAccessibleName(/0:01 to 0:04/);
  });

  it("offers no edges — a visitor is not editing this take", () => {
    mount();
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
  });

  it("shows the words a span covers when it is selected, and says when the emotion was substituted", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Region 2 of 2/ }));
    expect(screen.getByText(/whisper was asked for/)).toBeInTheDocument();
    expect(screen.getByText(/calm · 0:01–0:04/)).toBeInTheDocument();
  });

  it("deselects on a second click rather than trapping the reader on one span", () => {
    mount();
    const r = screen.getByRole("button", { name: /Region 1 of 2/ });
    fireEvent.click(r);
    fireEvent.click(r);
    expect(screen.getByText(/Select one to read the words it covers/)).toBeInTheDocument();
  });

  it("counts the substituted segments up front", () => {
    mount();
    expect(screen.getByText(/1 of 2 segments was substituted/)).toBeInTheDocument();
  });

  it("renders nothing for a take with no segment structure", () => {
    const { container } = mount({ ...TAKE, segments: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a take whose duration is unknown", () => {
    const { container } = mount({
      ...TAKE,
      seconds: 0,
      segments: [seg({ seconds: 0 })],
    });
    expect(container).toBeEmptyDOMElement();
  });
});

// ── the cast ────────────────────────────────────────────────────────────────
// A published ensemble used to arrive here as one flat rail, every span drawn
// as though a single voice had said all of it.

const ENSEMBLE: SharedTake = {
  ...TAKE,
  seconds: 6,
  segments: [
    seg({ text: "you said you would call", seconds: 2,
          character_id: "sarah", character_name: "Sarah" }),
    seg({ text: "I know", seconds: 1, character_id: "malik", character_name: "Malik" }),
    seg({ text: "well?", seconds: 3, character_id: "sarah", character_name: "Sarah" }),
  ],
};

describe("laneSegments — one lane per speaker, in first-spoken order", () => {
  it("groups a Character's spans together and keeps their absolute time", () => {
    const { spans } = placeSegments(ENSEMBLE.segments, 6);
    const lanes = laneSegments(spans);
    expect(lanes.map((l) => l.characterId)).toEqual(["sarah", "malik"]);
    expect(lanes[0].spans.map((s) => [s.start, s.end])).toEqual([[0, 2], [3, 6]]);
    expect(lanes[1].spans.map((s) => [s.start, s.end])).toEqual([[2, 3]]);
  });

  it("is ONE lane for a take that names no cast", () => {
    const { spans } = placeSegments(TAKE.segments, 4);
    expect(laneSegments(spans)).toHaveLength(1);
  });

  it("falls back to the id when a segment names one with no display name", () => {
    const { spans } = placeSegments([seg({ character_id: "x9", seconds: 1 })], 1);
    expect(laneSegments(spans)[0].name).toBe("x9");
  });
});

describe("TakeScore — an ensemble take is drawn as a scene", () => {
  it("stacks one labelled rail per Character", () => {
    mount(ENSEMBLE);
    expect(screen.getByRole("group", { name: /^Sarah — 2 segments over 0:06/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /^Malik — 1 segment over 0:06/ })).toBeInTheDocument();
    // ...and NOT the single flat rail the take used to get.
    expect(screen.queryByRole("group", { name: /Performance score/ })).toBeNull();
  });

  it("counts the voices in the header", () => {
    mount(ENSEMBLE);
    expect(screen.getByText(/2 voices · 3 segments/)).toBeInTheDocument();
  });

  it("names the speaker of the span you select", () => {
    mount(ENSEMBLE);
    fireEvent.click(screen.getByRole("button", { name: /Region 2 of 3/ }));
    expect(screen.getByText("Malik:")).toBeInTheDocument();
  });

  it("draws a single-Character take exactly as it always did", () => {
    // One named speaker is not a cast: stacking one lane and labelling it
    // would be ceremony around a fact the header already states.
    mount({ ...TAKE, segments: TAKE.segments.map((s) => ({ ...s, character_id: "sarah", character_name: "Sarah" })) });
    expect(screen.getByRole("group", { name: /Performance score/ })).toBeInTheDocument();
    expect(screen.queryByText(/voices ·/)).toBeNull();
  });
});

// ── the seek seam ───────────────────────────────────────────────────────────
// The score used to be read-only by inheritance: the card next to it owned its
// <audio> privately, so there was nothing to seek. Handed the page's transport,
// every rail becomes the transport it always looked like.

const transport = (over: Partial<React.ComponentProps<typeof TakeScore>["transport"] & object> = {}) => ({
  playing: false,
  progress: 0,
  seekFraction: vi.fn(),
  ...over,
});

describe("TakeScore — seeking the transport it is handed", () => {
  it("is an inert picture with no transport, and a slider with one", () => {
    const { unmount } = mount();
    expect(screen.queryByRole("slider")).toBeNull();
    unmount();
    render(<TakeScore take={TAKE} transport={transport()} />);
    expect(screen.getByRole("slider", { name: /Performance score/ })).toBeInTheDocument();
  });

  it("seeks to where the rail was operated, as a fraction of the take", () => {
    const t = transport();
    render(<TakeScore take={TAKE} transport={t} />);
    const rail = screen.getByRole("slider", { name: /Performance score/ });
    fireEvent.keyDown(rail, { key: "End" });
    expect(t.seekFraction).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(rail, { key: "Home" });
    expect(t.seekFraction).toHaveBeenLastCalledWith(0);
  });

  it("plays from the start of the span you select", () => {
    const t = transport();
    render(<TakeScore take={TAKE} transport={t} />);
    // Segment two starts at 0:01 of a 0:04 take.
    fireEvent.click(screen.getByRole("button", { name: /Region 2 of 2/ }));
    expect(t.seekFraction).toHaveBeenCalledWith(0.25);
    // …and still says what it covers. Seeking replaced nothing.
    expect(screen.getByText(/calm · 0:01–0:04/)).toBeInTheDocument();
  });

  it("draws the playhead on every lane of an ensemble, over one timeline", () => {
    const { container } = render(
      <TakeScore take={ENSEMBLE} transport={transport({ playing: true, progress: 0.5 })} />,
    );
    const heads = [...container.querySelectorAll("[style*='box-shadow']")] as HTMLElement[];
    expect(heads).toHaveLength(2); // one per Character lane
    expect(heads.every((h) => h.style.left === "50%")).toBe(true);
  });

  it("seeks the SAME timeline from a cast lane", () => {
    const t = transport();
    render(<TakeScore take={ENSEMBLE} transport={t} />);
    fireEvent.keyDown(screen.getByRole("slider", { name: /^Malik/ }), { key: "End" });
    expect(t.seekFraction).toHaveBeenLastCalledWith(1);
  });
});

describe("hasScore — what the share page asks before dropping the ribbon", () => {
  it("is true for a take with placeable segments", () => {
    expect(hasScore(TAKE)).toBe(true);
  });

  it("is false when there is nothing to draw, so the ribbon stays the fallback", () => {
    expect(hasScore({ ...TAKE, segments: [] })).toBe(false);
    expect(hasScore({ ...TAKE, seconds: 0, segments: [seg({ seconds: 0 })] })).toBe(false);
  });
});
