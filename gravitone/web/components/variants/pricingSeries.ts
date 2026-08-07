// The shape of the landing pricing chart, derived — never re-derived.
//
// Every number here comes out of lib/switchkit.ts. That module is the single
// source of truth for the comparison (it exists because the SwitchKit estimator
// and the /benchmarks planner had each grown their own copy of the arithmetic
// and drifted), and a chart is exactly the kind of surface that is tempted to
// hardcode "the shape" and let it rot. So this file computes coordinates and
// nothing else: no prices, no tier names, no break-even of its own.
//
// It is separate from the chart component so it can be tested without recharts,
// and so the section can render its legend, its honesty copy and its table view
// from the same numbers the plot draws — the table view is the chart's
// WCAG-clean twin, and a twin computed twice is not a twin.

import {
  ARM_BOXES,
  CHARS_PER_AUDIO_MINUTE,
  ELEVENLABS_TIERS,
  HOURS_PER_MONTH,
  breakEvenChars,
  elCostForChars,
  elTierFor,
  type ArmBox,
  type ElTier,
} from "@/lib/switchkit";

/** The small always-on preset — the one the story is about. */
export const SMALL_BOX: ArmBox = ARM_BOXES[0];
/** The larger preset, for volumes the small one would be silly at. */
export const LARGE_BOX: ArmBox = ARM_BOXES[1];

/** What a box costs running 24/7 — the worst case for us, and the only honest
 *  one to plot: an always-on box bills whether or not it is speaking. */
export function boxMonthlyUsd(box: ArmBox): number {
  return box.usdPerHour * HOURS_PER_MONTH;
}

/** How much audio a box can actually serve in a month, in characters. */
export function boxCapacityChars(box: ArmBox): number {
  return box.aggregateRtf * 60 * HOURS_PER_MONTH * CHARS_PER_AUDIO_MINUTE;
}

/*
 * The x domain starts at the Starter tier's ceiling, not at zero and not at the
 * Free tier.
 *
 * Two reasons, one of them load-bearing. The axis is logarithmic — cost and
 * volume both span three-plus orders of magnitude here, and a linear axis would
 * flatten the entire comparison into the bottom 2% of the plot until the very
 * last tier, hiding the crossover this section exists to be honest about. A log
 * axis cannot render 0, and ElevenLabs' Free tier IS $0. So the free tier is
 * stated in the caption instead of plotted: nothing self-hosted beats free, and
 * pretending otherwise by starting the axis at $1 would be the lie.
 */
export const CHART_MIN_CHARS = ELEVENLABS_TIERS[1].charsPerMonth; // Starter
export const CHART_MAX_CHARS = 20_000_000; // past Business, into extrapolation

export type PricePoint = {
  chars: number;
  /** ElevenLabs list price for that monthly volume. */
  el: number;
  /** The small Arm box, 24/7. Flat — that is the whole point. */
  small: number;
  /** The larger Arm box, 24/7. */
  large: number;
};

/** The tier ceilings that fall inside the plotted domain — the x reference
 *  ticks. Volume milestones a reader recognises beat an arbitrary 1M/5M/10M
 *  ruler, and they beat a slider: the story arrives without being dragged out. */
export function milestones(): ElTier[] {
  return ELEVENLABS_TIERS.filter(
    (t) => t.charsPerMonth >= CHART_MIN_CHARS && t.charsPerMonth <= CHART_MAX_CHARS,
  );
}

/**
 * The plotted points.
 *
 * ElevenLabs pricing is a right-continuous staircase — every character up to a
 * tier's ceiling costs the same, and the character after it costs a whole tier
 * more. Drawing that as a smooth ramp would misstate it, so each ceiling
 * contributes a PAIR of points one character apart: on a log axis those two x
 * values are the same pixel, and the segment between them is the riser. The
 * step is in the data, not in a `type="step"` prop that a later edit could drop.
 *
 * Past the top published tier the line is an extrapolation at that tier's
 * $/char (elCostForChars' own rule), sampled a few times so the reader can see
 * it is a ramp and not another step.
 */
export function pricingSeries(): PricePoint[] {
  const xs = new Set<number>([CHART_MIN_CHARS]);
  for (const t of ELEVENLABS_TIERS) {
    if (t.charsPerMonth > CHART_MIN_CHARS && t.charsPerMonth < CHART_MAX_CHARS) {
      xs.add(t.charsPerMonth); // last character at this tier's price
      xs.add(t.charsPerMonth + 1); // first character at the next one's
    }
  }
  const top = ELEVENLABS_TIERS[ELEVENLABS_TIERS.length - 1].charsPerMonth;
  for (const f of [1.2, 1.5, 1.8]) {
    const x = Math.round(top * f);
    if (x > CHART_MIN_CHARS && x < CHART_MAX_CHARS) xs.add(x);
  }
  xs.add(CHART_MAX_CHARS);

  const small = boxMonthlyUsd(SMALL_BOX);
  const large = boxMonthlyUsd(LARGE_BOX);
  return [...xs]
    .sort((a, b) => a - b)
    .map((chars) => ({ chars, el: elCostForChars(chars), small, large }));
}

export type Crossover = {
  box: ArmBox;
  usdPerMonth: number;
  /** Volume above which the box is the cheaper bill. null if it never is. */
  chars: number | null;
};

/** Where each box stops costing more than the tier that would cover you.
 *  Straight from breakEvenChars — the same function the honesty copy quotes. */
export function crossovers(): Crossover[] {
  return [SMALL_BOX, LARGE_BOX].map((box) => ({
    box,
    usdPerMonth: boxMonthlyUsd(box),
    chars: breakEvenChars(box),
  }));
}

/** One row of the chart's table view. */
export type TableRow = {
  tier: ElTier;
  audioMinutes: number;
  el: number;
  small: number;
  large: number;
};

export function tableRows(): TableRow[] {
  const small = boxMonthlyUsd(SMALL_BOX);
  const large = boxMonthlyUsd(LARGE_BOX);
  return milestones().map((tier) => ({
    tier,
    audioMinutes: tier.charsPerMonth / CHARS_PER_AUDIO_MINUTE,
    el: elCostForChars(tier.charsPerMonth),
    small,
    large,
  }));
}

/** Compact volume label for an axis tick — "100k", "2M". */
export function fmtChars(chars: number): string {
  if (chars >= 1_000_000) {
    const m = chars / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(chars / 1_000)}k`;
}

/** The tier a hovered volume actually lands on, for the readout. */
export const tierAt = elTierFor;
