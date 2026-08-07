import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { EmptyTakes, RenderRail } from "./signal";

/*
 * The playground's Signal accents, asserted at the one property that cannot be
 * eyeballed: THE STILL RENDER IS THE COMPLETE DRAWING.
 *
 * `prefers-reduced-motion` is the state nobody develops in, so it is the state
 * that silently rots — and the failure mode is not "less motion", it is a
 * missing picture or (as the equalizer this replaced actually did) a solid
 * block. The rule from DESIGN.md is: gate the animation, never drop the
 * element. Every path present when `still` is false must be present when it is
 * true, with no dash offset left holding it back.
 */

/** Every `d` a component painted, in order. */
const paths = (el: HTMLElement) =>
  Array.from(el.querySelectorAll("path")).map((p) => p.getAttribute("d") ?? "");

describe("EmptyTakes — the log that has nothing in it still draws what a take is", () => {
  it("keeps the sentence verbatim as its caption", () => {
    const { getByText } = render(<EmptyTakes still={false} />);
    expect(getByText("No takes yet — compose above and hit Generate.")).toBeInTheDocument();
  });

  it("draws the same geometry stilled as it does animated", () => {
    const moving = render(<EmptyTakes still={false} />).container as HTMLElement;
    const frozen = render(<EmptyTakes still />).container as HTMLElement;
    expect(paths(frozen)).toEqual(paths(moving));
    expect(paths(frozen).length).toBeGreaterThanOrEqual(2);
  });

  it("is finished, not part-drawn, when stilled — no stroke is held back", () => {
    const { container } = render(<EmptyTakes still />);
    for (const p of container.querySelectorAll("path")) {
      // A dash-draw in progress parks a non-zero offset; a finished one has
      // none at all. (The dashed "route not taken" stroke keeps its dash
      // PATTERN — that is the stroke's meaning, not its animation.)
      const off = p.getAttribute("stroke-dashoffset");
      expect(off === null || Number(off) === 0).toBe(true);
    }
  });

  it("labels and caption are readable immediately when stilled", () => {
    const { getByText } = render(<EmptyTakes still />);
    expect(getByText("nothing recorded")).toBeInTheDocument();
    expect(getByText("take 01")).toBeInTheDocument();
  });

  it("hides the drawing from assistive tech — the caption carries it", () => {
    const { container } = render(<EmptyTakes still={false} />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("RenderRail — the loader has an honest frame at rest", () => {
  it("draws the rail and the wave in both states", () => {
    const moving = render(<RenderRail still={false} />).container as HTMLElement;
    const frozen = render(<RenderRail still />).container as HTMLElement;
    expect(paths(moving)).toHaveLength(2);
    // The element is never dropped: stilled is the finished wave, not nothing.
    expect(paths(frozen)).toEqual(paths(moving));
  });

  it("renders no dash-draw animation at all when stilled", () => {
    const { container } = render(<RenderRail still />);
    for (const p of container.querySelectorAll("path")) {
      expect(p.getAttribute("stroke-dasharray")).toBeNull();
    }
  });

  it("stays out of the accessibility tree — the elapsed clock is the report", () => {
    const { container } = render(<RenderRail still={false} />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
