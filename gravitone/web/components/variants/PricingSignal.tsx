"use client";

import { fmtUsd } from "@/lib/switchkit";
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
  type CumulativePoint,
} from "./pricingTimeline";
import {
  Caption,
  Draw,
  HAIR,
  Illus,
  Label,
  Node,
  TravelPulse,
  accentVar,
} from "./features/previews/illus";

/*
 * switch · SIGNAL — x is TIME, and the argument is a slope.
 *
 * This replaced a log-log recharts plot of cost against volume. A volume chart
 * asks the reader to imagine the months; the months ARE the claim, so this one
 * draws them. Twenty-four ticks unroll left to right, and on each one a bill
 * lands: the subscription's staircase climbs a full riser every month and walks
 * off the top of the frame, while the rented box's staircase — same construction,
 * same monthly landing — rises so slowly it reads as a floor.
 *
 * THE THIRD LINE IS THE POINT. The x-axis itself is drawn in the accent, because
 * the software is the line that never leaves the floor: MIT, self-hosted, $0 on
 * month 1 and $0 on month 24. Everything above it is hardware you rent from
 * somebody. A picture that drew "self-hosted" as one cheap line would be hiding
 * that the cheap line is not the software at all.
 *
 * TWO PANELS, TWO SCALES, ONE HONESTY. The top panel is drawn at Pro-tier volume
 * and its own gap caliper. The bottom panel is the SAME twenty-four months at
 * Starter volume — below break-even — at its OWN scale, where the accent line is
 * the one ON TOP because an always-on box bills whether or not it speaks. Two
 * panels rather than two y-axes on one plot: a dual axis would have let the
 * losing case share the winner's ruler and disappear into it. The scale change
 * is announced on the drawing, not assumed.
 *
 * EVERY FIGURE IS COMPUTED. ./pricingTimeline.ts derives all of it from
 * lib/switchkit.ts — prices, break-even, the box's 24/7 rate — and the geometry
 * is scaled BY those figures, so a re-priced tier table moves the drawing
 * instead of leaving it quietly lying.
 *
 * ONE ACCENT. Cyan is what you keep: the free software, the flat box lane, the
 * gap. The other bill is hairline white throughout, and identity never rests on
 * that — every line is directly labelled here, named again in the legend, and
 * listed in the table underneath.
 */

const W = 680;
const H = 404;
const CYAN = accentVar("cyan");
const OTHER = "rgba(255,255,255,0.55)";

const N = TIMELINE_MONTHS;

/* ── the numbers, once ─────────────────────────────────────────────────────── */

const HEAD = cumulativeSeries(HEADLINE_CHARS);
const BELOW = cumulativeSeries(BELOW_CHARS);
const HEAD_RATE = monthlyPair(HEADLINE_CHARS);

const EL_TOTAL = HEAD[N].el;
const BOX_TOTAL = HEAD[N].box;
const GAP = gapUsd(HEADLINE_CHARS);
const BELOW_EL_TOTAL = BELOW[N].el;

/** "Graviton t4g.small (2 vCPU)" → "t4g.small". The legend and the table carry
 *  the full preset name; a diagram annotation gets the part that identifies it. */
const BOX_SHORT = BOX.name.replace(/^Graviton\s+/, "").replace(/\s*\(.*\)$/, "");

/* ── geometry, scaled by those numbers ─────────────────────────────────────── */

const X0 = 76;
const X1 = 596;
const at = (month: number) => X0 + (month / N) * (X1 - X0);

/** Panel A — above break-even, at the headline volume. Full height goes to the
 *  larger of the two totals, which at this volume is the subscription. */
const BASE_A = 238;
const TOP_A = 58;
const MAX_A = Math.max(EL_TOTAL, BOX_TOTAL);
const yA = (usd: number) => BASE_A - (usd / MAX_A) * (BASE_A - TOP_A);

/** Panel B — below break-even. Its own ruler, and it says so. */
const BASE_B = 378;
const TOP_B = 326;
const MAX_B = Math.max(BELOW_EL_TOTAL, BOX_TOTAL);
const yB = (usd: number) => BASE_B - (usd / MAX_B) * (BASE_B - TOP_B);

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * A cumulative total as a STAIRCASE.
 *
 * Both bills are monthly, so both are drawn with a riser at the head of each
 * month and a flat through it. Not a smooth ramp: a ramp draws a meter ticking
 * over, and neither of these is metered — they are things that land, again, on a
 * date. The two lanes therefore differ only in riser height, which is the entire
 * comparison stated as geometry.
 */
function stair(points: CumulativePoint[], pick: (p: CumulativePoint) => number, y: (usd: number) => number) {
  const parts = [`M${r2(at(0))} ${r2(y(pick(points[0])))}`];
  for (let m = 1; m < points.length; m++) {
    const v = y(pick(points[m]));
    parts.push(`L${r2(at(m - 1))} ${r2(v)}`, `L${r2(at(m))} ${r2(v)}`);
  }
  return parts.join(" ");
}

const EL_PATH = stair(HEAD, (p) => p.el, yA);
const BOX_PATH = stair(HEAD, (p) => p.box, yA);
const BELOW_EL_PATH = stair(BELOW, (p) => p.el, yB);
const BELOW_BOX_PATH = stair(BELOW, (p) => p.box, yB);

/** The months, as ticks under the axis — time actually unrolling rather than a
 *  domain a caption asserts. */
const MONTH_TICKS = Array.from({ length: N }, (_, i) => i + 1);
const LABELLED = [6, 12, 18];
const MARKED = [6, 12, 18, 24];

/* Choreography. The ticks sweep, the two lanes draw across the same window, and
 * the conclusions (the caliper, the losing panel) arrive after. */
const T_TICKS = 0.3;
const T_DRAW = 0.4;
const D_DRAW = 1.7;
const T_GAP = T_DRAW + D_DRAW + 0.25;
const T_BELOW = T_GAP + 0.55;

export default function PricingSignal({ still }: { still: boolean }) {
  return (
    <div>
      <Illus w={W} h={H} grid>
        <Label x={X0} y={30} size={11} still={still}>
          cumulative spend
        </Label>
        {/* The volume assumption, on the drawing, directly under the thing it
            qualifies. A cumulative comparison without it is not a chart, it is
            a claim. */}
        <Label x={X0} y={46} size={10} accent="cyan" delay={0.15} still={still}>
          {`at ${HEADLINE_TIER.name} volume · ${fmtChars(HEADLINE_CHARS)} chars/mo`}
        </Label>

        {/* ── the months ───────────────────────────────────────────────────── */}
        {MONTH_TICKS.map((m, i) => (
          <Draw
            key={m}
            d={`M${r2(at(m))} ${BASE_A} V${BASE_A + 7}`}
            delay={T_TICKS + i * 0.05}
            duration={0.12}
            stroke={HAIR}
            width={1}
            still={still}
          />
        ))}
        {LABELLED.map((m) => (
          <Label
            key={m}
            x={at(m)}
            y={259}
            anchor="middle"
            size={8}
            delay={T_TICKS + m * 0.05}
            still={still}
          >
            {`m${m}`}
          </Label>
        ))}

        {/* ── the software: the axis itself, and it never leaves the floor ─── */}
        <Draw
          d={`M${X0} ${BASE_A} H${X1}`}
          delay={0.1}
          duration={0.5}
          stroke={CYAN}
          width={2}
          still={still}
        />
        {/* Below the month labels, not beside them — the axis is the series, so
            its name sits under the whole span rather than at one end of it. */}
        <Label x={X0} y={275} size={9} accent="cyan" delay={0.6} still={still}>
          gravitone itself · $0 · mit · forever
        </Label>

        {/* ── the subscription, landing again every month ──────────────────── */}
        <Draw d={EL_PATH} delay={T_DRAW} duration={D_DRAW} stroke={OTHER} width={2} still={still} />
        <TravelPulse
          d={EL_PATH}
          delay={T_DRAW}
          duration={D_DRAW}
          color="rgba(255,255,255,0.85)"
          size={4.5}
          still={still}
        />
        {MARKED.map((m) => (
          <Node
            key={m}
            x={at(m)}
            y={yA(HEAD[m].el)}
            r={2.8}
            delay={T_DRAW + (m / N) * D_DRAW}
            still={still}
          />
        ))}
        {/* Parked in the empty quadrant the staircase leaves above itself,
            which is the region the subscription is climbing into. */}
        <Label x={at(3) + 10} y={yA(HEAD[14].el)} size={9} delay={T_DRAW + 0.5} still={still}>
          {`+${fmtUsd(HEAD_RATE.el)} every month`}
        </Label>
        <Label x={X1} y={TOP_A - 12} anchor="end" size={10} delay={T_DRAW + D_DRAW} still={still}>
          {`elevenlabs ${HEADLINE_TIER.name.toLowerCase()} · ${fmtUsd(EL_TOTAL)}`}
        </Label>

        {/* ── the box: same construction, a slope you can put a ruler on ───── */}
        <Draw d={BOX_PATH} delay={T_DRAW} duration={D_DRAW} stroke={CYAN} width={2} still={still} />
        <TravelPulse d={BOX_PATH} delay={T_DRAW} duration={D_DRAW} color={CYAN} size={4.5} still={still} />
        <Label
          x={X1}
          y={yA(BOX_TOTAL) - 10}
          anchor="end"
          size={10}
          accent="cyan"
          delay={T_DRAW + D_DRAW}
          still={still}
        >
          {`${BOX_SHORT} 24/7 · ${fmtUsd(BOX_TOTAL)}`}
        </Label>
        <Label
          x={X1}
          y={yA(BOX_TOTAL) + 16}
          anchor="end"
          size={9}
          delay={T_DRAW + D_DRAW + 0.1}
          still={still}
        >
          {`+${fmtUsd(HEAD_RATE.box)} every month · flat`}
        </Label>

        {/* ── the gap, drawn to scale and measured ─────────────────────────── */}
        <Draw
          d={`M${X1 + 8} ${r2(yA(EL_TOTAL))} H${X1 + 2} M${X1 + 8} ${r2(yA(EL_TOTAL))} V${r2(
            yA(BOX_TOTAL),
          )} M${X1 + 8} ${r2(yA(BOX_TOTAL))} H${X1 + 2}`}
          delay={T_GAP}
          duration={0.45}
          stroke={HAIR}
          width={1.2}
          still={still}
        />
        <Label x={X1 - 16} y={132} anchor="end" size={11} accent="cyan" delay={T_GAP + 0.25} still={still}>
          {`${fmtUsd(GAP)} apart`}
        </Label>
        <Label x={X1 - 16} y={148} anchor="end" size={9} delay={T_GAP + 0.35} still={still}>
          {`after ${N} months`}
        </Label>

        {/* ── and the half where we lose ───────────────────────────────────── */}
        <Draw
          d={`M${X0} 292 H${X1}`}
          delay={T_BELOW}
          duration={0.4}
          stroke="rgba(255,255,255,0.10)"
          width={1}
          still={still}
        />
        {/* The scale change is announced, not assumed. */}
        <Label x={X0} y={308} size={10} delay={T_BELOW} still={still}>
          {`below break-even · ${fmtChars(BELOW_CHARS)} chars/mo · own scale`}
        </Label>
        <Draw
          d={`M${X0} ${BASE_B} H${X1}`}
          delay={T_BELOW + 0.1}
          duration={0.35}
          stroke="rgba(255,255,255,0.12)"
          width={1}
          still={still}
        />
        <Draw
          d={BELOW_BOX_PATH}
          delay={T_BELOW + 0.2}
          duration={0.7}
          stroke={CYAN}
          width={2}
          still={still}
        />
        <Draw
          d={BELOW_EL_PATH}
          delay={T_BELOW + 0.2}
          duration={0.7}
          stroke={OTHER}
          width={2}
          still={still}
        />
        <Label
          x={X1}
          y={yB(BOX_TOTAL) - 9}
          anchor="end"
          size={9}
          accent="cyan"
          delay={T_BELOW + 0.9}
          still={still}
        >
          {`${BOX_SHORT} 24/7 · ${fmtUsd(BOX_TOTAL)}`}
        </Label>
        <Label
          x={X1}
          y={yB(BELOW_EL_TOTAL) + 15}
          anchor="end"
          size={9}
          delay={T_BELOW + 0.95}
          still={still}
        >
          {`elevenlabs ${BELOW_TIER.name.toLowerCase()} · ${fmtUsd(BELOW_EL_TOTAL)}`}
        </Label>
        <Label x={X0} y={396} size={9} delay={T_BELOW + 1.05} still={still}>
          {BREAK_EVEN_CHARS === null
            ? "here the box is the worse buy"
            : `under ${fmtChars(BREAK_EVEN_CHARS)} chars/mo the box is the worse buy`}
        </Label>
      </Illus>

      <Caption delay={T_BELOW + 1.3} still={still}>
        There is no crossover <em>month</em> — only a crossover <em>volume</em>. Above{" "}
        {BREAK_EVEN_CHARS?.toLocaleString("en-US")} characters a month the rented box is the cheaper
        bill from the first month and the gap only widens; below it, the box bills all 730 hours
        whether or not it speaks, and the subscription wins. The software is $0 either way.
      </Caption>
    </div>
  );
}
