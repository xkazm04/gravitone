import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { fmtUsd } from "@/lib/switchkit";
import PricingBills from "./PricingBills";
import PricingClimb from "./PricingClimb";
import {
  END_CHARS,
  TIMELINE_MONTHS,
  crossoverMonth,
  cumulativeCrossoverMonth,
  cumulativeSeries,
  growthSeries,
  tierSteps,
} from "./pricingTimeline";

/*
 * PROTOTYPING ROUND — the properties each pricing direction has to hold,
 * whichever one is eventually chosen.
 *
 * The two that are easy to lose and impossible to eyeball:
 *
 *   THE PARAGRAPHS STAY DEAD. These variants exist because two honesty blocks
 *   were factually right and unread. If a variant grows a block of running
 *   prose back, the round has failed silently — so every <p> in a variant is
 *   size-capped, and the assumption is only allowed to travel as chips.
 *
 *   A STILLED RENDER IS THE FINISHED PICTURE. DESIGN.md's reduced-motion rule:
 *   gate the animation, never drop the element. A stilled variant must already
 *   read its final totals, hold every label, and keep no stroke back behind a
 *   dash offset.
 */

const SERIES = growthSeries();
const CUM = cumulativeSeries(SERIES);
const TOTALS = CUM[CUM.length - 1];
const MONTHLY_CROSS = crossoverMonth(SERIES)!;
const TOTAL_CROSS = cumulativeCrossoverMonth(CUM)!;

/** Every stroke that is still hidden behind its own dash offset. */
function undrawn(root: HTMLElement): Element[] {
  return [...root.querySelectorAll("path")].filter((p) => {
    const off = p.getAttribute("stroke-dashoffset") ?? p.style.strokeDashoffset;
    return off !== "" && off !== null && Math.abs(Number(off)) >= 1 && p.getAttribute("fill") !== "none";
  });
}

/** The text a reader would have to wade through, paragraph by paragraph. */
function paragraphs(root: HTMLElement): string[] {
  return [...root.querySelectorAll("p")].map((p) => p.textContent?.trim() ?? "");
}

describe("PricingBills · variant A, the two bills", () => {
  it("holds both 24-month totals as its hero, stilled", () => {
    const { container } = render(<PricingBills still />);
    const text = container.textContent ?? "";
    expect(text).toContain(fmtUsd(TOTALS.el));
    expect(text).toContain(fmtUsd(TOTALS.box));
    // …and the increment that explains them: theirs ends on the top tier, ours
    // never moved off the machine's month.
    expect(text).toContain(`+${fmtUsd(SERIES[SERIES.length - 1].el)}`);
    expect(text).toContain(`+${fmtUsd(SERIES[0].boxUsd)}`);
  });

  it("marks BOTH crossings and never conflates them", () => {
    const { container } = render(<PricingBills still />);
    const text = container.textContent ?? "";
    // The month the monthly charge flips…
    expect(text).toContain(`month ${MONTHLY_CROSS} · the month flips`);
    // …and the later month the running totals do. Same picture, two facts.
    expect(text).toContain(`month ${TOTAL_CROSS} · the totals cross`);
    expect(TOTAL_CROSS).toBeGreaterThan(MONTHLY_CROSS);
  });

  it("keeps the drawing under the arm's-length label budget", () => {
    const { container } = render(<PricingBills still />);
    // DESIGN.md: more than about eight text elements inside the illustration
    // and the drawing has stopped carrying the story.
    expect(container.querySelectorAll("svg text").length).toBeLessThanOrEqual(8);
  });

  it("carries no paragraph of running prose — one caption, and it is short", () => {
    const { container } = render(<PricingBills still />);
    const ps = paragraphs(container);
    expect(ps).toHaveLength(1);
    for (const p of ps) expect(p.length).toBeLessThanOrEqual(120);
  });

  it("renders the complete picture when motion is off", () => {
    const { container } = render(<PricingBills still />);
    expect(undrawn(container)).toHaveLength(0);
    // The span is named at both ends and the software's floor is on the axis —
    // a stilled render is the END of the story, not a blank stage.
    const text = container.textContent ?? "";
    expect(text).toContain("month 1 ·");
    expect(text).toContain(`month ${TIMELINE_MONTHS} ·`);
    expect(text).toContain("gravitone · $0 · mit");
  });
});

describe("PricingClimb · variant B, the climb", () => {
  it("draws the published ladder from the tier table, named and priced", () => {
    const { container } = render(<PricingClimb still />);
    const text = container.textContent ?? "";
    // Every tier the span visits is named with its own published figure —
    // above the road where it stands, below it in the valley caption.
    for (const step of tierSteps(SERIES)) {
      expect(text.toLowerCase()).toContain(step.tier.name.toLowerCase());
      expect(text).toContain(fmtUsd(step.tier.usdPerMonth));
    }
    // …and the causeway carries the machine's own price.
    expect(text).toContain(`${fmtUsd(SERIES[0].boxUsd)}/mo`);
  });

  it("draws the honest valley rather than footnoting it", () => {
    const { container } = render(<PricingClimb still />);
    const text = container.textContent ?? "";
    expect(text).toContain(`months 1-${MONTHLY_CROSS - 1}`);
    expect(text).toContain(`month ${MONTHLY_CROSS} · the climb crosses`);
    // The valley is geometry, not a caption: the two cheap tiers sit BELOW the
    // road's altitude in the same coordinate space as the rest of the picture.
    const cheap = tierSteps(SERIES).filter((s) => s.tier.usdPerMonth <= SERIES[0].boxUsd);
    expect(cheap.length).toBeGreaterThan(0);
    for (const s of cheap) expect(s.toMonth).toBeLessThan(MONTHLY_CROSS);
  });

  it("stamps both 24-month totals once, at the end", () => {
    const { container } = render(<PricingClimb still />);
    const text = container.textContent ?? "";
    expect(text).toContain(fmtUsd(TOTALS.el));
    expect(text).toContain(fmtUsd(TOTALS.box));
  });

  it("keeps the drawing under the arm's-length label budget", () => {
    const { container } = render(<PricingClimb still />);
    expect(container.querySelectorAll("svg text").length).toBeLessThanOrEqual(8);
  });

  it("carries no paragraph of running prose — one caption, and it is short", () => {
    const { container } = render(<PricingClimb still />);
    const ps = paragraphs(container);
    expect(ps).toHaveLength(1);
    for (const p of ps) expect(p.length).toBeLessThanOrEqual(120);
  });

  it("renders the complete picture when motion is off", () => {
    const { container } = render(<PricingClimb still />);
    expect(undrawn(container)).toHaveLength(0);
    // The read-out is the END of the climb, not a zero waiting to be animated.
    expect(container.textContent).toContain(END_CHARS.toLocaleString("en-US"));
  });
});
