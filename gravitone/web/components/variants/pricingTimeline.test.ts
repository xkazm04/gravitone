import { describe, expect, it } from "vitest";
import {
  ELEVENLABS_TIERS,
  HOURS_PER_MONTH,
  breakEvenChars,
  elCostForChars,
  estimateMonthly,
} from "@/lib/switchkit";
import {
  BELOW_CHARS,
  BELOW_TIER,
  BOX,
  BREAK_EVEN_CHARS,
  HEADLINE_CHARS,
  HEADLINE_TIER,
  TIMELINE_MONTHS,
  cumulativeSeries,
  fmtChars,
  gapUsd,
  monthlyPair,
  timelineRows,
} from "./pricingTimeline";

/*
 * The illustration is scaled BY these numbers, so a drift here is a drawing that
 * lies to the pixel. Two things are asserted above all: that nothing is
 * re-derived (every figure has to equal what lib/switchkit.ts says), and that
 * the two volume assumptions still straddle the break-even — the whole honesty
 * of the section is that one of the two panels is the case where we lose.
 */

describe("pricingTimeline", () => {
  it("takes every price from switchkit rather than re-deriving one", () => {
    const per = monthlyPair(HEADLINE_CHARS);
    expect(per.el).toBe(elCostForChars(HEADLINE_CHARS));
    expect(per.box).toBe(BOX.usdPerHour * HOURS_PER_MONTH);
    expect(per.box).toBe(estimateMonthly(HEADLINE_CHARS, BOX).boxUsd);
    // The software is the third series, and it is zero by construction.
    expect(per.software).toBe(0);
  });

  it("straddles the break-even — one assumed volume above it, one below", () => {
    expect(BREAK_EVEN_CHARS).toBe(breakEvenChars(BOX));
    expect(BREAK_EVEN_CHARS).not.toBeNull();
    expect(HEADLINE_CHARS).toBeGreaterThan(BREAK_EVEN_CHARS!);
    expect(BELOW_CHARS).toBeLessThan(BREAK_EVEN_CHARS!);
    // …and below it the box really is the worse buy, which is the half the
    // section refuses to hide.
    const low = monthlyPair(BELOW_CHARS);
    expect(low.box).toBeGreaterThan(low.el);
  });

  it("names each assumed volume by the tier that actually covers it", () => {
    expect(HEADLINE_TIER).toBe(ELEVENLABS_TIERS.find((t) => t.charsPerMonth >= HEADLINE_CHARS));
    expect(BELOW_TIER).toBe(ELEVENLABS_TIERS.find((t) => t.charsPerMonth >= BELOW_CHARS));
  });

  it("accumulates from zero, one month at a time, linearly", () => {
    const s = cumulativeSeries(HEADLINE_CHARS);
    expect(s).toHaveLength(TIMELINE_MONTHS + 1);
    expect(s[0]).toEqual({ month: 0, el: 0, box: 0, software: 0 });
    const per = monthlyPair(HEADLINE_CHARS);
    for (const p of s) {
      expect(p.el).toBeCloseTo(per.el * p.month, 8);
      expect(p.box).toBeCloseTo(per.box * p.month, 8);
      expect(p.software).toBe(0);
    }
    // Deterministic: the server and the client scale the picture identically.
    expect(cumulativeSeries(HEADLINE_CHARS)).toEqual(s);
  });

  it("keeps the box's riser the same height every month — that is the claim", () => {
    const s = cumulativeSeries(HEADLINE_CHARS);
    const risers = s.slice(1).map((p, i) => p.box - s[i].box);
    for (const r of risers) expect(r).toBeCloseTo(risers[0], 8);
    // And a lower riser than the subscription's, at this volume.
    expect(risers[0]).toBeLessThan(s[1].el - s[0].el);
  });

  it("reports the gap signed — negative where the box loses, never clamped", () => {
    const per = monthlyPair(HEADLINE_CHARS);
    expect(gapUsd(HEADLINE_CHARS)).toBeCloseTo((per.el - per.box) * TIMELINE_MONTHS, 8);
    expect(gapUsd(HEADLINE_CHARS)).toBeGreaterThan(0);
    expect(gapUsd(BELOW_CHARS)).toBeLessThan(0);
  });

  it("gives the table one row per published tier, with the loser marked", () => {
    const rows = timelineRows();
    expect(rows.map((r) => r.tier.name)).toEqual(ELEVENLABS_TIERS.map((t) => t.name));
    for (const r of rows) {
      expect(r.elTotal).toBeCloseTo(r.elMonth * TIMELINE_MONTHS, 8);
      expect(r.boxTotal).toBeCloseTo(r.boxMonth * TIMELINE_MONTHS, 8);
      expect(r.boxCostsMore).toBe(r.boxMonth > r.elMonth);
    }
    // The free tier is $0 and nothing self-hosted beats free. If that row ever
    // stops being marked, the table has started flattering us.
    expect(rows[0].boxCostsMore).toBe(true);
    expect(rows.some((r) => !r.boxCostsMore)).toBe(true);
  });

  it("formats volumes compactly", () => {
    expect(fmtChars(30_000)).toBe("30k");
    expect(fmtChars(500_000)).toBe("500k");
    expect(fmtChars(2_000_000)).toBe("2M");
    expect(fmtChars(1_500_000)).toBe("1.5M");
  });
});
