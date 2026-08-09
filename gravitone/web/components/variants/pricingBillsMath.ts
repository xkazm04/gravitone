/*
 * Everything "the two bills" is drawn FROM: the derived series, the coordinate
 * space, the two envelopes, and the clock the whole scene runs on.
 *
 * Pure, and module-scope on purpose. Nothing here is a figure typed in by hand
 * — the months, the prices and the two crossings all come out of
 * ./pricingTimeline (and through it lib/switchkit.ts), so a re-priced tier moves
 * the drawing instead of leaving it quietly lying.
 */

import {
  TIMELINE_MONTHS,
  crossoverMonth,
  cumulativeCrossoverMonth,
  cumulativeSeries,
  growthSeries,
} from "./pricingTimeline";
import { easedTimeFor } from "./pricingEasing";

export const W = 1160;
export const H = 250;

/* ── the numbers, once ─────────────────────────────────────────────────────── */

export const SERIES = growthSeries();
export const CUM = cumulativeSeries(SERIES);
export const N = TIMELINE_MONTHS;
export const MONTHLY_CROSS = crossoverMonth(SERIES);
export const TOTAL_CROSS = cumulativeCrossoverMonth(CUM);
export const TOTALS = CUM[CUM.length - 1];
/** The two odometer tapes, hoisted: a fresh array on every render would restart
 *  the count mid-story. */
export const EL_STEPS = CUM.map((p) => p.el);
export const BOX_STEPS = CUM.map((p) => p.box);
/** The tallest monthly charge on either side — the one scale both slabs use. */
const MAX_MONTH = Math.max(...SERIES.map((p) => Math.max(p.el, p.boxUsd)));

/** "Graviton t4g.small (2 vCPU)" → "t4g.small". */
export const short = (name: string) => name.replace(/^Graviton\s+/, "").replace(/\s*\(.*\)$/, "");

/* ── geometry ──────────────────────────────────────────────────────────────── */

export const X0 = 46;
export const X1 = 1114;
export const ZERO = 170; // the $0 line — and the software's own price
export const TOP = 30; // y of the largest monthly charge in the span
export const at = (month: number) => X0 + ((month - 1) / (N - 1)) * (X1 - X0);
export const up = (usd: number) => ZERO - (usd / MAX_MONTH) * (ZERO - TOP);
export const down = (usd: number) => ZERO + (usd / MAX_MONTH) * (ZERO - TOP);
export const r2 = (v: number) => Math.round(v * 100) / 100;

/** A monthly charge as a STAIRCASE: a tier is a price you are IN for a whole
 *  month and then step out of, so the riser sits exactly on the month. */
function stair(value: (i: number) => number, project: (usd: number) => number) {
  const parts = [`M${r2(at(1))} ${r2(project(value(0)))}`];
  for (let i = 1; i < N; i++) {
    parts.push(`L${r2(at(i + 1))} ${r2(project(value(i - 1)))}`, `L${r2(at(i + 1))} ${r2(project(value(i)))}`);
  }
  parts.push(`L${r2(X1)} ${r2(project(value(N - 1)))}`);
  return parts.join(" ");
}

export const EL_PATH = stair((i) => SERIES[i].el, up);
export const BOX_PATH = stair((i) => SERIES[i].boxUsd, down);
/** The same envelopes closed back to the $0 line — the slab, whose area is the
 *  total. Nothing is redrawn here: it is the stroke plus two closing edges. */
export const EL_SLAB = `${EL_PATH} L${r2(X1)} ${ZERO} L${r2(X0)} ${ZERO} Z`;
export const BOX_SLAB = `${BOX_PATH} L${r2(X1)} ${ZERO} L${r2(X0)} ${ZERO} Z`;

/* ── choreography ──────────────────────────────────────────────────────────── */

export const T_ZERO = 0.15;
export const T_RUN = 0.45; // both bills start billing
export const D_RUN = 2.0; // twenty-four months
export const T_CAP = T_RUN + D_RUN + 0.3; // the caption lands inside 3 seconds

/** The delay at which the sweep reaches `month`. */
const whenMonth = (month: number) => T_RUN + easedTimeFor((month - 1) / (N - 1)) * D_RUN;

export const T_MONTHLY_CROSS = MONTHLY_CROSS === null ? T_RUN : whenMonth(MONTHLY_CROSS);
export const T_SWAP = TOTAL_CROSS === null ? T_RUN + D_RUN : whenMonth(TOTAL_CROSS);
