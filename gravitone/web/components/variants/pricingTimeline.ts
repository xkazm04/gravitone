// The shape of the landing pricing illustration, derived — never re-derived.
//
// THE STORY THIS FILE COMPUTES: one project's usage GROWING, month after month,
// and the two bills that grow with it — or don't.
//
// It has been through three shapes. It plotted cost against VOLUME on a log-log
// chart (volume is not an axis anyone lives on). Then it accumulated two fixed
// monthly bills over 24 months at ONE assumed volume — which quietly made the
// whole comparison a function of the volume we picked, and had no crossover in
// it at all, because at a fixed volume the winner is decided in month 1. Usage
// growth is the honest version of both: the thing that actually changes over two
// years is how much you generate, the subscription's staircase is a function OF
// that, and the crossover becomes a real MONTH — the month usage passes the
// point where a tier costs more than the machine.
//
// Every price comes out of lib/switchkit.ts — that module is the single source
// of truth for the comparison (it exists because the SwitchKit estimator and the
// /benchmarks planner had each grown their own copy of the arithmetic and
// drifted). This file computes MONTHS, USAGE and COORDINATE-READY COSTS and
// nothing else: no prices, no tier names, no break-even of its own.
//
// It is separate from the illustration so it can be tested without rendering
// anything, and so the section can render its legend, its honesty copy and its
// table view from the same numbers the drawing is scaled by — the table is the
// picture's WCAG-clean twin, and a twin computed twice is not a twin.

import {
  ARM_BOXES,
  CHARS_PER_AUDIO_MINUTE,
  ELEVENLABS_TIERS,
  HOURS_PER_MONTH,
  breakEvenChars,
  estimateMonthly,
  type ArmBox,
  type ElTier,
} from "@/lib/switchkit";

/** How far the story runs. Two years: long enough that growth has a shape,
 *  short enough that nobody has to believe a five-year projection. */
export const TIMELINE_MONTHS = 24;

/** The box the story starts on — the small always-on Graviton preset. */
export const BOX: ArmBox = ARM_BOXES[0];

/** What that box costs for a month, from switchkit: on-demand list price × all
 *  730 hours. Not a rate we retype; `estimateMonthly` owns it. */
export const BOX_USD_MONTH = estimateMonthly(0, BOX).boxUsd;

/*
 * THE GROWTH ASSUMPTION, and why these two endpoints.
 *
 * A comparison over time needs a usage curve, and picking the curve picks the
 * winner — so the endpoints are not numbers we chose, they are two published
 * tier ceilings, and the section states the whole assumption in visible prose.
 *
 *   START — the SMALLEST tier's ceiling (the free allowance): month 1 is a
 *     project that has just launched and fits inside what ElevenLabs gives away.
 *     Starting here is deliberately the unflattering choice: in month 1 their
 *     bill is $0 and no self-hosted machine beats $0.
 *   END   — the SECOND-LARGEST tier's ceiling: a serious product, still short of
 *     the enterprise tier. Ending here rather than at the top of the table keeps
 *     the projection inside volumes an indie project actually reaches.
 *
 * Between them, CONSTANT-RATE growth — the same percentage every month. It is
 * one number a reader can check (GROWTH_PCT), it has no inflection we could have
 * placed to flatter ourselves, and it is what "a product that keeps growing"
 * means. A linear ramp would have been the flattering choice: it spends far more
 * of the two years at high volume, where we win.
 */
export const START_CHARS = ELEVENLABS_TIERS[0].charsPerMonth;
export const END_CHARS = ELEVENLABS_TIERS[ELEVENLABS_TIERS.length - 2].charsPerMonth;

/** Month-over-month growth factor that carries START to END across the span. */
export const GROWTH = (END_CHARS / START_CHARS) ** (1 / (TIMELINE_MONTHS - 1));
/** The same figure as the percentage the prose quotes. */
export const GROWTH_PCT = Math.round((GROWTH - 1) * 100);

/**
 * Usage in a given month — `month` may be fractional, so a read-out can tick
 * along the same curve the drawing is scaled by.
 *
 * The endpoints are returned exactly rather than as `10000 * GROWTH ** 23`,
 * because the story's first and last figures are tier ceilings a reader can
 * look up and floating-point drift would make them ALMOST that.
 */
export function usageAt(month: number, months: number = TIMELINE_MONTHS): number {
  if (month <= 1) return START_CHARS;
  if (month >= months) return END_CHARS;
  return Math.round(START_CHARS * GROWTH ** (month - 1));
}

/**
 * The preset that can actually carry a month's volume.
 *
 * `overCapacity` is switchkit's own definition (audio-minutes against the box's
 * measured throughput for all 730 hours), so the upgrade rule here is not a
 * second opinion. If the growing volume ever outruns the small box, the series
 * steps up to the next preset and the drawing gets an honest riser — at the
 * current table it never does, and the section says so out loud rather than
 * letting the absence of a step read as an absence of a limit.
 */
export function boxFor(chars: number): ArmBox {
  return (
    ARM_BOXES.find((b) => !estimateMonthly(chars, b).overCapacity) ??
    ARM_BOXES[ARM_BOXES.length - 1]
  );
}

/** One month of the story: what was generated, and what each side billed. */
export type GrowthPoint = {
  month: number;
  /** Characters generated that month. */
  chars: number;
  audioMinutes: number;
  /** The cheapest ElevenLabs tier covering that month's volume. */
  tier: ElTier;
  /** Their bill that month, from switchkit. */
  el: number;
  /** The preset carrying that month's volume, and what it bills running 24/7 —
   *  the worst case for us, and the only honest one: an always-on machine does
   *  not stop when you stop talking. */
  box: ArmBox;
  boxUsd: number;
  /** The software itself. Zero. MIT, self-hosted, no seat and no meter. A field
   *  rather than a literal in the drawing because a series the eye is asked to
   *  follow should come from the same place as its siblings. */
  software: 0;
  /** True in the months where the SUBSCRIPTION is the cheaper bill. Never
   *  clamped away — lib/switchkit.ts leaves `savingsUsd` signed for the same
   *  reason, and those months are the point of drawing the whole span. */
  boxCostsMore: boolean;
};

export function growthSeries(months: number = TIMELINE_MONTHS): GrowthPoint[] {
  const out: GrowthPoint[] = [];
  for (let month = 1; month <= months; month++) {
    const chars = usageAt(month, months);
    const box = boxFor(chars);
    const e = estimateMonthly(chars, box);
    out.push({
      month,
      chars,
      audioMinutes: e.audioMinutes,
      tier: e.elTier,
      el: e.elUsd,
      box,
      boxUsd: e.boxUsd,
      software: 0,
      boxCostsMore: e.boxUsd > e.elUsd,
    });
  }
  return out;
}

/** The first month in which the box is the cheaper bill — the real crossover,
 *  now that usage moves. null if it never happens inside the span. */
export function crossoverMonth(series: GrowthPoint[]): number | null {
  return series.find((p) => !p.boxCostsMore)?.month ?? null;
}

/** The first month the small preset can no longer carry the volume and the
 *  series steps up. null when one box carries the whole span. */
export function boxUpgradeMonth(series: GrowthPoint[]): number | null {
  return series.find((p) => p.box !== series[0].box)?.month ?? null;
}

/** The quiet running totals — one secondary figure, not a second chart. */
export function growthTotals(series: GrowthPoint[]): { el: number; box: number; gap: number } {
  const el = series.reduce((a, p) => a + p.el, 0);
  const box = series.reduce((a, p) => a + p.boxUsd, 0);
  // Signed, never clamped: below the crossover this difference is negative and
  // the section is required to be able to say so.
  return { el, box, gap: el - box };
}

/** The monthly volume at which the box STARTS being the cheaper bill: the
 *  ceiling of the cheapest tier priced above the box's 24/7 cost. */
export const BREAK_EVEN_CHARS: number | null = breakEvenChars(BOX);

/**
 * The last monthly volume at which the SUBSCRIPTION is still the cheaper bill.
 *
 * This is the number the honesty copy needs, and it is NOT `BREAK_EVEN_CHARS`.
 * That one names the ceiling of the first tier priced above the machine, so
 * saying "below it the box costs more" was wrong for every volume between the
 * two: at 50k chars/mo you are already paying for that tier and the box has
 * already won. What is true is that the subscription wins up to and including
 * the ceiling of the most expensive tier priced AT OR UNDER the box's month.
 */
export const EL_CHEAPER_THROUGH_CHARS: number | null =
  ELEVENLABS_TIERS.filter((t) => t.usdPerMonth <= BOX_USD_MONTH).at(-1)?.charsPerMonth ?? null;

/* ── accumulation: the same series read as two running bills ───────────────── */

/** A month's RUNNING TOTALS, plus that month's own charge — what an odometer
 *  reads at month N, and what the tick that just landed added to it. */
export type CumulativePoint = {
  month: number;
  /** Everything ElevenLabs has billed through this month, inclusive. */
  el: number;
  /** Everything the machine has billed through this month, inclusive. */
  box: number;
  /** This month's charge on each side — the increment the odometer just took.
   *  Theirs grows as the volume climbs tiers; ours is the same every month, and
   *  that difference IS the story the accumulation tells. */
  elMonth: number;
  boxMonth: number;
};

export function cumulativeSeries(series: GrowthPoint[] = growthSeries()): CumulativePoint[] {
  let el = 0;
  let box = 0;
  return series.map((p) => {
    el += p.el;
    box += p.boxUsd;
    return { month: p.month, el, box, elMonth: p.el, boxMonth: p.boxUsd };
  });
}

/**
 * The month the SUBSCRIPTION'S RUNNING TOTAL passes the machine's.
 *
 * This is NOT `crossoverMonth`, and conflating the two would be a lie of the
 * flattering kind. `crossoverMonth` is the month the two MONTHLY bills cross —
 * from then on every further month is cheaper on the machine. But the machine
 * spent the early months in front, so it is still ahead on the TOTAL for a while
 * after that: this is the month the debt is actually repaid. A picture whose
 * hero is a running total has to mark the running total's crossing, not borrow
 * the monthly one's earlier date.
 */
export function cumulativeCrossoverMonth(
  cum: CumulativePoint[] = cumulativeSeries(),
): number | null {
  return cum.find((p) => p.el > p.box)?.month ?? null;
}

/* ── the tier ladder, as spans rather than per-month repeats ────────────────── */

/** One published tier and the run of months this timeline spends inside it —
 *  the step of the staircase, with its width. */
export type TierStep = {
  tier: ElTier;
  fromMonth: number;
  toMonth: number;
};

/** The consecutive runs of months sharing one tier. Drawn as terrain, this is
 *  the ladder; the tier names and prices on it are the citation, so they come
 *  from switchkit's table and are never retyped into a drawing. */
export function tierSteps(series: GrowthPoint[] = growthSeries()): TierStep[] {
  const steps: TierStep[] = [];
  for (const p of series) {
    const last = steps[steps.length - 1];
    if (last && last.tier === p.tier) last.toMonth = p.month;
    else steps.push({ tier: p.tier, fromMonth: p.month, toMonth: p.month });
  }
  return steps;
}

/* ── the assumption, as data rather than as a sentence ─────────────────────── */

/** A key→value micro-row. The growth assumption used to be a paragraph; it is
 *  the same facts, formatted, because a landing reader scans chips and skips
 *  prose — and a fact nobody reads is not a disclosure. */
export type AssumptionChip = { k: string; v: string };

/**
 * Every assumption the comparison rests on, derived — nothing here is typed by
 * hand. If the tier table, the growth rate, the box preset or the span moves,
 * these rows move with it.
 */
export function assumptionChips(series: GrowthPoint[] = growthSeries()): AssumptionChip[] {
  const last = series[series.length - 1];
  const peak = estimateMonthly(last.chars, last.box);
  const upgrade = boxUpgradeMonth(series);
  const n = (v: number) => Math.round(v).toLocaleString("en-US");
  return [
    { k: "usage", v: `${fmtChars(START_CHARS)} → ${fmtChars(END_CHARS)} chars/mo` },
    { k: "growth", v: `+${GROWTH_PCT}% every month` },
    { k: "span", v: `${series.length} months` },
    { k: "their price", v: "whichever published tier covers the month" },
    { k: "our price", v: `${BOX.name}, billed all ${HOURS_PER_MONTH} h/mo` },
    { k: "audio", v: `${n(CHARS_PER_AUDIO_MINUTE)} chars ≈ 1 audio-min` },
    {
      k: "headroom",
      v:
        upgrade === null
          ? `peak ${n(peak.audioMinutes)} of ${n(peak.boxCapacityMinutes)} audio-min/mo — one box carries the span`
          : `the box steps up to the larger preset in month ${upgrade}`,
    },
  ];
}

/** Compact volume label — "30k", "500k", "2M". */
export function fmtChars(chars: number): string {
  if (chars >= 1_000_000) {
    const m = chars / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(chars / 1_000)}k`;
}
