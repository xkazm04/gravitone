import { describe, expect, it } from "vitest";
import {
  ARM_BOXES,
  ELEVENLABS_TIERS,
  HOURS_PER_MONTH,
  breakEvenChars,
  elCostForChars,
  elTierFor,
  estimateMonthly,
} from "@/lib/switchkit";
import {
  BOX,
  BOX_USD_MONTH,
  BREAK_EVEN_CHARS,
  EL_CHEAPER_THROUGH_CHARS,
  END_CHARS,
  GROWTH,
  GROWTH_PCT,
  START_CHARS,
  TIMELINE_MONTHS,
  assumptionChips,
  boxFor,
  boxUpgradeMonth,
  crossoverMonth,
  cumulativeCrossoverMonth,
  cumulativeSeries,
  fmtChars,
  growthSeries,
  growthTotals,
  tierSteps,
  usageAt,
} from "./pricingTimeline";

/*
 * The illustration is scaled BY these numbers, so a drift here is a drawing that
 * lies to the pixel. Three things are asserted above all: that nothing is
 * re-derived (every figure has to equal what lib/switchkit.ts says), that the
 * growth curve really runs between two published tier ceilings at a constant
 * rate, and that the crossover month is the month the two bills actually swap —
 * with the months before it left in, because those are the ones we lose.
 */

const SERIES = growthSeries();

describe("pricingTimeline", () => {
  it("takes every price from switchkit rather than re-deriving one", () => {
    for (const p of SERIES) {
      expect(p.el).toBe(elCostForChars(p.chars));
      expect(p.el).toBe(estimateMonthly(p.chars, p.box).elUsd);
      expect(p.boxUsd).toBe(p.box.usdPerHour * HOURS_PER_MONTH);
      expect(p.tier).toBe(elTierFor(p.chars));
      // The software is the third series, and it is zero by construction.
      expect(p.software).toBe(0);
    }
    expect(BOX_USD_MONTH).toBe(BOX.usdPerHour * HOURS_PER_MONTH);
  });

  it("grows between two published tier ceilings at one constant rate", () => {
    expect(START_CHARS).toBe(ELEVENLABS_TIERS[0].charsPerMonth);
    expect(END_CHARS).toBe(ELEVENLABS_TIERS[ELEVENLABS_TIERS.length - 2].charsPerMonth);
    // The endpoints are exact — they are figures a reader can look up.
    expect(usageAt(1)).toBe(START_CHARS);
    expect(usageAt(TIMELINE_MONTHS)).toBe(END_CHARS);
    expect(GROWTH ** (TIMELINE_MONTHS - 1)).toBeCloseTo(END_CHARS / START_CHARS, 6);
    expect(GROWTH_PCT).toBe(Math.round((GROWTH - 1) * 100));
    // Constant rate: every consecutive ratio is the same one, and it is the one
    // the prose quotes. A curve with an inflection could have been placed to
    // flatter us; this one has nowhere to hide.
    for (let m = 2; m < TIMELINE_MONTHS; m++) {
      expect(usageAt(m) / usageAt(m - 1)).toBeCloseTo(GROWTH, 2);
    }
    // Monotonic, and fractional months follow the same curve (the read-out ticks
    // along it while the lines draw).
    for (let i = 1; i < SERIES.length; i++) expect(SERIES[i].chars).toBeGreaterThan(SERIES[i - 1].chars);
    expect(usageAt(6.5)).toBeGreaterThan(usageAt(6));
    expect(usageAt(6.5)).toBeLessThan(usageAt(7));
    // Deterministic: the server and the client scale the picture identically.
    expect(growthSeries()).toEqual(SERIES);
  });

  it("runs one month per step, from month 1", () => {
    expect(SERIES).toHaveLength(TIMELINE_MONTHS);
    expect(SERIES.map((p) => p.month)).toEqual(
      Array.from({ length: TIMELINE_MONTHS }, (_, i) => i + 1),
    );
    for (const p of SERIES) expect(p.audioMinutes).toBe(estimateMonthly(p.chars, p.box).audioMinutes);
  });

  it("keeps the box's monthly cost flat — that is the whole claim", () => {
    for (const p of SERIES) expect(p.boxUsd).toBe(SERIES[0].boxUsd);
    // …while the subscription's is a staircase that only ever climbs.
    for (let i = 1; i < SERIES.length; i++) expect(SERIES[i].el).toBeGreaterThanOrEqual(SERIES[i - 1].el);
    expect(SERIES[SERIES.length - 1].el).toBeGreaterThan(SERIES[0].el);
  });

  it("puts the crossover at the month the two bills actually swap", () => {
    const cross = crossoverMonth(SERIES);
    expect(cross).not.toBeNull();
    // Every month before it: the subscription is the cheaper bill, and the
    // series says so rather than clamping it away.
    for (const p of SERIES.filter((p) => p.month < cross!)) {
      expect(p.boxCostsMore).toBe(true);
      expect(p.el).toBeLessThan(p.boxUsd);
    }
    // From it on: never again.
    for (const p of SERIES.filter((p) => p.month >= cross!)) {
      expect(p.boxCostsMore).toBe(false);
      expect(p.el).toBeGreaterThan(p.boxUsd);
    }
    // The crossover is real, not cosmetic: there ARE months we lose, and they
    // are inside the drawn span.
    expect(cross!).toBeGreaterThan(1);
    expect(cross!).toBeLessThan(TIMELINE_MONTHS);
    // And it is the month the volume enters the tier breakEvenChars names.
    expect(BREAK_EVEN_CHARS).toBe(breakEvenChars(BOX));
    expect(SERIES[cross! - 1].tier.charsPerMonth).toBe(BREAK_EVEN_CHARS);
  });

  it("names the volume the subscription is cheaper THROUGH, not the tier above it", () => {
    // EL_CHEAPER_THROUGH_CHARS is deliberately NOT BREAK_EVEN_CHARS: the tier
    // that ceiling belongs to already costs more than the machine, so "below
    // 100k the box loses" was false for every volume in between.
    expect(EL_CHEAPER_THROUGH_CHARS).not.toBeNull();
    expect(EL_CHEAPER_THROUGH_CHARS!).toBeLessThan(BREAK_EVEN_CHARS!);
    expect(elCostForChars(EL_CHEAPER_THROUGH_CHARS!)).toBeLessThan(BOX_USD_MONTH);
    expect(elCostForChars(EL_CHEAPER_THROUGH_CHARS! + 1)).toBeGreaterThan(BOX_USD_MONTH);
    // Every month at or under it loses; every month past it wins.
    for (const p of SERIES) {
      expect(p.boxCostsMore).toBe(p.chars <= EL_CHEAPER_THROUGH_CHARS!);
    }
  });

  it("upgrades the box only when the volume really outruns it", () => {
    // boxFor is switchkit's own capacity rule, not a second opinion.
    for (const p of SERIES) {
      expect(p.box).toBe(boxFor(p.chars));
      expect(estimateMonthly(p.chars, p.box).overCapacity).toBe(false);
    }
    // At the current benchmark table one small box carries the whole span — so
    // there is no riser to draw, and the section says that out loud rather than
    // letting the absence read as an absence of a limit.
    expect(boxUpgradeMonth(SERIES)).toBeNull();
    // The rule still steps up when it has to.
    const huge = ARM_BOXES[0].aggregateRtf * 60 * HOURS_PER_MONTH * 1000 * 2;
    expect(boxFor(huge)).not.toBe(ARM_BOXES[0]);
  });

  it("totals the span without clamping the sign", () => {
    const t = growthTotals(SERIES);
    expect(t.el).toBeCloseTo(SERIES.reduce((a, p) => a + p.el, 0), 8);
    expect(t.box).toBeCloseTo(BOX_USD_MONTH * TIMELINE_MONTHS, 8);
    expect(t.gap).toBeCloseTo(t.el - t.box, 8);
    // Negative where the box loses — the early months, taken on their own.
    const early = growthTotals(SERIES.filter((p) => p.boxCostsMore));
    expect(early.gap).toBeLessThan(0);
  });

  it("formats volumes compactly", () => {
    expect(fmtChars(30_000)).toBe("30k");
    expect(fmtChars(500_000)).toBe("500k");
    expect(fmtChars(2_000_000)).toBe("2M");
    expect(fmtChars(1_500_000)).toBe("1.5M");
  });
});

/*
 * The accumulation helpers, added for the "two bills" direction. The one thing
 * here that is easy to get wrong — and flattering when you do — is which month
 * counts as the crossing, so it gets its own test.
 */
describe("pricingTimeline · accumulation", () => {
  const CUM = cumulativeSeries(SERIES);

  it("accumulates both bills month by month, keeping each month's increment", () => {
    expect(CUM).toHaveLength(SERIES.length);
    expect(CUM[0].el).toBeCloseTo(SERIES[0].el, 8);
    expect(CUM[0].box).toBeCloseTo(SERIES[0].boxUsd, 8);
    const last = CUM[CUM.length - 1];
    expect(last.el).toBeCloseTo(growthTotals(SERIES).el, 8);
    expect(last.box).toBeCloseTo(growthTotals(SERIES).box, 8);
    // The increment is the month's own charge — theirs grows, ours never does.
    expect(CUM.map((p) => p.elMonth)).toEqual(SERIES.map((p) => p.el));
    expect(new Set(CUM.map((p) => p.boxMonth)).size).toBe(1);
    // Monotone: neither bill ever refunds a month.
    for (let i = 1; i < CUM.length; i++) {
      expect(CUM[i].el).toBeGreaterThanOrEqual(CUM[i - 1].el);
      expect(CUM[i].box).toBeGreaterThan(CUM[i - 1].box);
    }
  });

  it("crosses the TOTALS later than the monthly bills cross", () => {
    const monthly = crossoverMonth(SERIES)!;
    const total = cumulativeCrossoverMonth(CUM)!;
    // The machine spent the early months in front, so the debt outlives the
    // month the monthly bills swap. Borrowing the earlier date for a running
    // total would be the flattering lie this assertion exists to block.
    expect(total).toBeGreaterThan(monthly);
    const at = CUM[total - 1];
    const before = CUM[total - 2];
    expect(at.el).toBeGreaterThan(at.box);
    expect(before.el).toBeLessThanOrEqual(before.box);
  });
});

describe("pricingTimeline · the tier ladder", () => {
  const STEPS = tierSteps(SERIES);

  it("collapses the months into one step per published tier, in order", () => {
    // Every month lands in exactly one step, and the steps tile the span.
    expect(STEPS[0].fromMonth).toBe(1);
    expect(STEPS[STEPS.length - 1].toMonth).toBe(TIMELINE_MONTHS);
    for (let i = 1; i < STEPS.length; i++) {
      expect(STEPS[i].fromMonth).toBe(STEPS[i - 1].toMonth + 1);
      // A rising staircase: usage only grows, so the tier only climbs.
      expect(STEPS[i].tier.usdPerMonth).toBeGreaterThan(STEPS[i - 1].tier.usdPerMonth);
    }
    // The names and prices are switchkit's, never retyped into the drawing.
    for (const s of STEPS) expect(ELEVENLABS_TIERS).toContain(s.tier);
    // The story starts inside the free allowance — the unflattering start.
    expect(STEPS[0].tier.usdPerMonth).toBe(0);
  });
});

describe("pricingTimeline · the assumption as chips", () => {
  const CHIPS = assumptionChips(SERIES);

  it("carries every fact the paragraph carried, derived", () => {
    const flat = CHIPS.map((c) => `${c.k} ${c.v}`).join(" | ");
    expect(flat).toContain(fmtChars(START_CHARS));
    expect(flat).toContain(fmtChars(END_CHARS));
    expect(flat).toContain(`+${GROWTH_PCT}%`);
    expect(flat).toContain(`${TIMELINE_MONTHS} months`);
    expect(flat).toContain(`${HOURS_PER_MONTH} h/mo`);
    expect(flat).toContain(BOX.name);
    // The capacity claim, and it must be the honest branch for this table.
    expect(boxUpgradeMonth(SERIES)).toBeNull();
    expect(flat).toContain("one box carries the span");
  });

  it("keeps every chip short enough to be a chip and not a sentence", () => {
    // The whole point of the format: if a value grows into prose, the paragraph
    // has quietly come back.
    for (const c of CHIPS) expect(c.v.length).toBeLessThanOrEqual(72);
  });
});
