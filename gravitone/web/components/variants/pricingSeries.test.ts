import { describe, expect, it } from "vitest";
import {
  ARM_BOXES,
  CHARS_PER_AUDIO_MINUTE,
  ELEVENLABS_TIERS,
  HOURS_PER_MONTH,
  breakEvenChars,
  elCostForChars,
} from "@/lib/switchkit";
import {
  CHART_MAX_CHARS,
  CHART_MIN_CHARS,
  LARGE_BOX,
  SMALL_BOX,
  boxCapacityChars,
  boxMonthlyUsd,
  crossovers,
  fmtChars,
  milestones,
  pricingSeries,
  tableRows,
} from "./pricingSeries";

// The chart's job is to be TRUE first and pretty second. These tests pin the
// three ways a pricing chart lies: by inventing numbers of its own, by smoothing
// a staircase into a ramp, and by hiding the region where our own product loses.

describe("pricing series", () => {
  it("takes every price from lib/switchkit rather than restating one", () => {
    for (const p of pricingSeries()) {
      expect(p.el).toBe(elCostForChars(p.chars));
      expect(p.small).toBe(ARM_BOXES[0].usdPerHour * HOURS_PER_MONTH);
      expect(p.large).toBe(ARM_BOXES[1].usdPerHour * HOURS_PER_MONTH);
    }
  });

  it("keeps the box lines flat — the whole claim is that volume does not move them", () => {
    const pts = pricingSeries();
    expect(new Set(pts.map((p) => p.small)).size).toBe(1);
    expect(new Set(pts.map((p) => p.large)).size).toBe(1);
  });

  it("draws the tier staircase as steps, not a ramp", () => {
    const pts = pricingSeries();
    // Every published ceiling inside the domain contributes a riser: two x
    // values one character apart at two different prices.
    for (const t of ELEVENLABS_TIERS) {
      if (t.charsPerMonth <= CHART_MIN_CHARS || t.charsPerMonth >= CHART_MAX_CHARS) continue;
      const at = pts.find((p) => p.chars === t.charsPerMonth);
      const past = pts.find((p) => p.chars === t.charsPerMonth + 1);
      expect(at?.el).toBe(t.usdPerMonth);
      expect(past?.el).toBeGreaterThan(t.usdPerMonth);
    }
    // Monotonic: an ElevenLabs bill never goes DOWN as volume goes up.
    for (let i = 1; i < pts.length; i++) expect(pts[i].el).toBeGreaterThanOrEqual(pts[i - 1].el);
  });

  it("starts past the free tier, because a log axis cannot render $0", () => {
    // The Free tier is $0 for 10k chars — plotted it would break the scale, and
    // fudged upward it would be a lie. It is stated in the section's copy.
    expect(ELEVENLABS_TIERS[0].usdPerMonth).toBe(0);
    expect(CHART_MIN_CHARS).toBe(ELEVENLABS_TIERS[1].charsPerMonth);
    expect(pricingSeries()[0].el).toBeGreaterThan(0);
  });

  it("plots only volumes the small box could actually serve", () => {
    // A cost line drawn past a box's capacity is a price for work it cannot do.
    expect(boxCapacityChars(SMALL_BOX)).toBeGreaterThan(CHART_MAX_CHARS);
    expect(boxCapacityChars(LARGE_BOX)).toBeGreaterThan(CHART_MAX_CHARS);
  });

  it("keeps the crossovers as breakEvenChars reports them", () => {
    const [small, large] = crossovers();
    expect(small.box).toBe(SMALL_BOX);
    expect(small.chars).toBe(breakEvenChars(SMALL_BOX));
    expect(large.chars).toBe(breakEvenChars(LARGE_BOX));
    // And the marked crossover is inside the plotted domain — an off-canvas
    // caveat is not a caveat.
    expect(small.chars).not.toBeNull();
    expect(small.chars!).toBeGreaterThanOrEqual(CHART_MIN_CHARS);
    expect(small.chars!).toBeLessThanOrEqual(CHART_MAX_CHARS);
  });

  it("puts the below-crossover region where the box really is the worse buy", () => {
    const [small] = crossovers();
    const boxUsd = boxMonthlyUsd(SMALL_BOX);
    // At the domain's left edge the box costs more than the tier covering you.
    expect(elCostForChars(CHART_MIN_CHARS)).toBeLessThan(boxUsd);
    // At the crossover it does not.
    expect(elCostForChars(small.chars!)).toBeGreaterThan(boxUsd);
  });

  it("uses the published tiers as the volume ticks", () => {
    expect(milestones().map((t) => t.name)).toEqual(["Starter", "Creator", "Pro", "Scale", "Business"]);
  });

  it("mirrors the plot in the table view, row for row", () => {
    const rows = tableRows();
    expect(rows.map((r) => r.tier.name)).toEqual(milestones().map((t) => t.name));
    for (const r of rows) {
      expect(r.el).toBe(elCostForChars(r.tier.charsPerMonth));
      expect(r.audioMinutes).toBe(r.tier.charsPerMonth / CHARS_PER_AUDIO_MINUTE);
    }
    // The table must show the losing rows too, or it is not the chart's twin.
    expect(rows.some((r) => r.small > r.el)).toBe(true);
  });

  it("formats volumes the way a reader says them", () => {
    expect(fmtChars(30_000)).toBe("30k");
    expect(fmtChars(500_000)).toBe("500k");
    expect(fmtChars(2_000_000)).toBe("2M");
    expect(fmtChars(11_000_000)).toBe("11M");
  });
});
