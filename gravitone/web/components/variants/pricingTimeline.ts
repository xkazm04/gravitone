// The shape of the landing pricing illustration, derived — never re-derived.
//
// The section used to plot cost against VOLUME on a log-log chart. It now plots
// cost against TIME, because that is the shape of the claim the project actually
// makes: the software is free forever and a rented box accrues at a fixed rate,
// so what a subscription does over two years is the whole argument. A volume
// chart makes you imagine the months; a time chart draws them.
//
// Every number here comes out of lib/switchkit.ts — that module is the single
// source of truth for the comparison (it exists because the SwitchKit estimator
// and the /benchmarks planner had each grown their own copy of the arithmetic
// and drifted). This file computes MONTHS and COORDINATE-READY TOTALS and
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
  breakEvenChars,
  elTierFor,
  estimateMonthly,
  type ArmBox,
  type ElTier,
} from "@/lib/switchkit";

/** How far the story runs. Two years: long enough that an accumulation has a
 *  shape, short enough that nobody has to believe a five-year projection. */
export const TIMELINE_MONTHS = 24;

/** The box the story is about — the small always-on Graviton preset. */
export const BOX: ArmBox = ARM_BOXES[0];

/*
 * THE VOLUME ASSUMPTION, and why it is two numbers rather than one.
 *
 * A cumulative comparison without its volume is a lie: "$2,376 versus $294" is
 * only true at some particular monthly usage, and picking the usage picks the
 * winner. So the section names its assumption on the drawing itself, and it
 * draws BOTH sides of the break-even rather than the flattering one.
 *
 *   HEADLINE — 500k chars/mo, the Pro tier's own ceiling. Above break-even,
 *     where the box is the cheaper bill and the gap widens every month.
 *   BELOW    — 30k chars/mo, the Starter tier's ceiling. BELOW break-even,
 *     where an always-on box costs MORE, forever, and the picture says so at
 *     the same 24-month span.
 *
 * Both are tier ceilings rather than round numbers we chose, so neither is a
 * volume picked to win an argument.
 */
export const HEADLINE_CHARS = 500_000;
export const BELOW_CHARS = 30_000;

/** The cheapest tier that covers each assumed volume — via switchkit, so a tier
 *  table edit moves the labels instead of leaving them quietly lying. */
export const HEADLINE_TIER: ElTier = elTierFor(HEADLINE_CHARS);
export const BELOW_TIER: ElTier = elTierFor(BELOW_CHARS);

/** Monthly volume at which the always-on box starts being the cheaper bill.
 *  null if it never is within the published tiers. */
export const BREAK_EVEN_CHARS: number | null = breakEvenChars(BOX);

/** The two bills for one month at a given volume: the subscription that covers
 *  it, and the box running 24/7 whether or not it speaks. */
export type MonthlyPair = {
  /** The ElevenLabs list price for that monthly volume. */
  el: number;
  /** The box, billed all 730 hours — the worst case for us, and the only
   *  honest one: an always-on machine does not stop when you stop talking. */
  box: number;
  /** The software itself. Zero. MIT, self-hosted, no seat and no meter. This
   *  is a field rather than a literal in the drawing because a series the eye
   *  is asked to follow should come from the same place as its siblings. */
  software: 0;
};

export function monthlyPair(chars: number, box: ArmBox = BOX): MonthlyPair {
  const e = estimateMonthly(chars, box);
  return { el: e.elUsd, box: e.boxUsd, software: 0 };
}

/** One month of the accumulation: the running totals at the END of month n.
 *  `month: 0` is the day you started, before either bill has landed. */
export type CumulativePoint = {
  month: number;
  el: number;
  box: number;
  software: 0;
};

/**
 * The cumulative spend, month by month.
 *
 * Both bills are monthly and neither changes with time, so both totals are
 * staircases — one riser per month, of a height that never varies. That is
 * deliberately NOT collapsed into two straight lines: the risers are the story
 * (a subscription is a thing that lands again every month), and a smooth ramp
 * would draw a metered bill rather than a recurring one.
 */
export function cumulativeSeries(
  chars: number,
  box: ArmBox = BOX,
  months: number = TIMELINE_MONTHS,
): CumulativePoint[] {
  const per = monthlyPair(chars, box);
  const n = Math.max(0, Math.floor(months));
  const out: CumulativePoint[] = [];
  for (let month = 0; month <= n; month++) {
    out.push({ month, el: per.el * month, box: per.box * month, software: 0 });
  }
  return out;
}

/** What the subscription cost over the whole span that the box did not. Signed:
 *  NEGATIVE below break-even, where the box is the worse buy. Never clamp it —
 *  lib/switchkit.ts leaves `savingsUsd` unclamped for the same reason. */
export function gapUsd(
  chars: number,
  box: ArmBox = BOX,
  months: number = TIMELINE_MONTHS,
): number {
  const per = monthlyPair(chars, box);
  return (per.el - per.box) * months;
}

/** One row of the picture's table view — the same two bills, per published
 *  tier, at one month and across the whole span. */
export type TimelineRow = {
  tier: ElTier;
  audioMinutes: number;
  elMonth: number;
  boxMonth: number;
  elTotal: number;
  boxTotal: number;
  /** True where the always-on box is the WORSE buy at that volume. */
  boxCostsMore: boolean;
};

export function timelineRows(
  box: ArmBox = BOX,
  months: number = TIMELINE_MONTHS,
): TimelineRow[] {
  return ELEVENLABS_TIERS.map((tier) => {
    const per = monthlyPair(tier.charsPerMonth, box);
    return {
      tier,
      audioMinutes: tier.charsPerMonth / CHARS_PER_AUDIO_MINUTE,
      elMonth: per.el,
      boxMonth: per.box,
      elTotal: per.el * months,
      boxTotal: per.box * months,
      boxCostsMore: per.box > per.el,
    };
  });
}

/** Compact volume label — "30k", "500k", "2M". */
export function fmtChars(chars: number): string {
  if (chars >= 1_000_000) {
    const m = chars / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(chars / 1_000)}k`;
}
