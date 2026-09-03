import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Track from "./Track";

// The rail is the first primitive in the system that claims to represent TIME,
// so the two things it must never do are: draw a position it does not have, and
// be reachable only with a mouse.

/** Give the rail a real box — jsdom reports 0x0 for everything. */
function sized(el: Element, left = 0, width = 200) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    left, width, right: left + width, top: 0, bottom: 40, height: 40, x: left, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("Track — peaks, playhead, seek", () => {
  it("draws one bar per peak when the take has real peaks", () => {
    const { container } = render(<Track label="take" peaks={[0.2, 0.9, 0.4]} />);
    // 3 peak bars, and none of the idle keyframe bars.
    expect(container.querySelectorAll(".eq-bar")).toHaveLength(0);
    expect(container.querySelectorAll('[aria-hidden="true"] > span')).toHaveLength(3);
  });

  it("falls back to the shared idle bar field when there are no peaks", () => {
    const { container } = render(<Track label="take" bars={12} />);
    expect(container.querySelectorAll(".eq-bar")).toHaveLength(12);
  });

  it("draws NO texture at all for a lane whose content is its overlay", () => {
    const { container } = render(<Track label="lane" bars={0} />);
    expect(container.querySelectorAll(".eq-bar")).toHaveLength(0);
  });

  it("draws no playhead while nothing is playing", () => {
    const { container } = render(<Track label="take" progress={0.5} />);
    expect(container.querySelector("[style*='box-shadow']")).toBeNull();
  });

  it("draws the playhead at the reported position while playing", () => {
    const { container } = render(<Track label="take" progress={0.25} playing />);
    const head = container.querySelector("[style*='box-shadow']") as HTMLElement;
    expect(head).not.toBeNull();
    expect(head.style.left).toBe("25%");
  });

  it("clamps a nonsense progress instead of drawing off the rail", () => {
    const { container } = render(<Track label="take" progress={4} playing />);
    expect((container.querySelector("[style*='box-shadow']") as HTMLElement).style.left).toBe("100%");
  });

  it("is a plain labelled group when it cannot be seeked", () => {
    render(<Track label="score lane" />);
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.getByRole("group", { name: "score lane" })).toBeInTheDocument();
  });

  it("seeks to where it was clicked", () => {
    const onSeek = vi.fn();
    render(<Track label="take" onSeek={onSeek} progress={0} />);
    const rail = screen.getByRole("slider");
    sized(rail.parentElement as Element);
    sized(rail);
    fireEvent.click(rail, { clientX: 50 });
    expect(onSeek).toHaveBeenCalledWith(0.25);
  });

  it("seeks from the keyboard, which is the whole point of the slider role", () => {
    const onSeek = vi.fn();
    render(<Track label="take" onSeek={onSeek} progress={0.5} />);
    const rail = screen.getByRole("slider");
    fireEvent.keyDown(rail, { key: "ArrowRight" });
    expect(onSeek).toHaveBeenLastCalledWith(0.52);
    fireEvent.keyDown(rail, { key: "ArrowLeft" });
    expect(onSeek).toHaveBeenLastCalledWith(0.48);
    fireEvent.keyDown(rail, { key: "PageUp" });
    expect(onSeek).toHaveBeenLastCalledWith(0.6);
    fireEvent.keyDown(rail, { key: "Home" });
    expect(onSeek).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(rail, { key: "End" });
    expect(onSeek).toHaveBeenLastCalledWith(1);
  });

  it("never seeks past either end of the rail", () => {
    const onSeek = vi.fn();
    render(<Track label="take" onSeek={onSeek} progress={1} />);
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(onSeek).toHaveBeenLastCalledWith(1);
  });

  it("says the position out loud in the caller's own words", () => {
    render(
      <Track label="take" onSeek={() => {}} progress={0.5}
        valueText={(f) => `${Math.round(f * 40)} of 40 seconds`} />,
    );
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "20 of 40 seconds");
  });
});
