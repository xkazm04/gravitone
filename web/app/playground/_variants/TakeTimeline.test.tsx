import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import TakeTimeline from "./TakeTimeline";
import { DEFAULT_EXPRESSION, segmentRegions, type Segment, type Take } from "./shared";

const seg = (text: string, seconds: number, over: Partial<Segment> = {}): Segment => ({
  text, requested: "baseline", used: "baseline", fallback: false,
  voice_id: "v1", seconds, ...over,
});

function take(segments: Segment[], seconds: number): Take {
  return {
    id: "take-1", text: segments.map((s) => s.text).join(" "),
    characterId: "sarah", characterName: "Sarah", mode: "gravitone", url: "blob:x",
    peaks: [], seconds, kb: 1, rtf: 1, synthSeconds: 1, queueSeconds: 0,
    ignoredSettings: [], segments, expr: DEFAULT_EXPRESSION, createdAt: 1,
  };
}

function mount(segments: Segment[], seconds = 3, selected: number | null = null) {
  const onPick = vi.fn();
  const t = take(segments, seconds);
  render(
    <TakeTimeline
      take={t}
      regions={segmentRegions(segments, seconds)}
      selected={selected}
      onPick={onPick}
      characterName={(id) => (id === "bo" ? "Bo" : "Sarah")}
    />,
  );
  return { onPick };
}

const THREE = [seg("one", 1), seg("two", 1), seg("three", 1)];

describe("TakeTimeline — a take you can see the shape of", () => {
  it("draws one region per segment", () => {
    mount(THREE);
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("says where each region is and what it says, out loud", () => {
    // The ribbon of chips the card already draws has the same data WITHOUT its
    // position; a screen-reader user needs the position to edit.
    mount(THREE);
    const second = screen.getByRole("button", { name: /Segment 2 of 3/ });
    expect(second).toHaveAccessibleName(/starts at 0:01/);
    expect(second).toHaveAccessibleName(/1 seconds/);
    expect(second).toHaveAccessibleName(/text: two/);
  });

  it("names the speaking Character on a performance take", () => {
    mount([seg("one", 1, { characterId: "sarah" }), seg("two", 1, { characterId: "bo" })], 2);
    expect(screen.getByRole("button", { name: /Segment 2 of 2/ })).toHaveAccessibleName(/spoken by Bo/);
  });

  it("says when an emotion was substituted rather than drawing a mystery tint", () => {
    mount([seg("one", 1, { requested: "sad", used: "calm", fallback: true })], 1);
    expect(screen.getByRole("button", { name: /Segment 1 of 1/ }))
      .toHaveAccessibleName(/substituted for sad/);
  });

  it("clicking a region asks the caller to seek to it", () => {
    const { onPick } = mount(THREE);
    fireEvent.click(screen.getByRole("button", { name: /Segment 3 of 3/ }));
    expect(onPick).toHaveBeenCalledWith(2);
  });

  it("moves focus with the arrows and wraps, like the character rail", () => {
    // Arrows move focus only; activation is the button's own (Enter/Space fire a
    // click natively), so focus alone never moves the playhead by accident.
    mount(THREE);
    const [a, b, c] = screen.getAllByRole("button");
    a.focus();
    fireEvent.keyDown(a, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b, { key: "End" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: "ArrowRight" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: "Home" });
    expect(document.activeElement).toBe(a);
  });

  it("keeps exactly one region in the tab order", () => {
    mount(THREE, 3, 1);
    const tabbable = screen.getAllByRole("button").filter((b) => b.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAttribute("aria-pressed", "true");
  });

  it("renders nothing at all for a take with no segment report", () => {
    // Absent = invisible: a take the backend reported nothing about has no
    // timeline to draw, and an empty frame would be a claim of its own.
    const { container } = render(
      <TakeTimeline take={take([], 0)} regions={[]} selected={null} onPick={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
