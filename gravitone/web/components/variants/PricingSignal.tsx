"use client";

import { useEffect, useRef } from "react";
import { animate, motion } from "framer-motion";
import { fmtUsd } from "@/lib/switchkit";
import { EASE } from "@/components/ui/tokens";
import {
  BOX_USD_MONTH,
  END_CHARS,
  START_CHARS,
  TIMELINE_MONTHS,
  boxUpgradeMonth,
  crossoverMonth,
  fmtChars,
  growthSeries,
  usageAt,
  type GrowthPoint,
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
 * switch · SIGNAL — ONE statement, drawn full width:
 * **one bill grows with the usage, the other doesn't.**
 *
 * WHAT THIS REPLACED, AND WHY. The previous composition was a 680×404 card
 * holding two stacked panels, two rulers, a caliper, and a dozen 8px
 * annotations. It had borrowed Signal's TECHNIQUES without its philosophy:
 * Signal is one clear story told in motion with one accent, and a dense
 * miniature diagram is the opposite of that however hairline it is drawn. This
 * is the same argument at landscape scale with six labels in it.
 *
 * TIME IS THE AXIS AND USAGE IS THE ENGINE. Twenty-four months run left to
 * right while the project's monthly volume grows at a constant rate from the
 * free tier's ceiling to the second-largest tier's ceiling (./pricingTimeline.ts
 * states the assumption; the section states it again in prose, because the
 * drawing is aria-hidden). The read-out above the plot ticks along that same
 * curve as the lines draw, so the growth is something you WATCH driving the
 * divergence rather than something a footnote asserts.
 *
 * TWO LINES, ONE SCALE, NO CALIPERS. The subscription is a staircase because
 * tiers are steps — each riser is the month a volume crossed into the next
 * published tier. The box is flat because a rented machine bills 730 hours
 * whether or not it speaks. Both on ONE linear dollar axis: no second ruler, no
 * log trick, so the early months where the subscription is genuinely cheaper are
 * drawn at the same scale as the late months where it is not.
 *
 * THE HONEST HALF IS THE FIRST FIFTH OF THE PICTURE. Their line starts ON the
 * floor ($0 — the free tier) and stays under the machine until the crossover.
 * That span is washed and named on the drawing, and the crossover is marked
 * where the riser actually passes through the flat line. Nothing is compressed
 * to get past it faster.
 *
 * EVERY FIGURE IS COMPUTED — prices, capacity, break-even and the crossover
 * month all come from lib/switchkit.ts via ./pricingTimeline.ts, and the
 * geometry is scaled BY those figures, so a re-priced tier table moves the
 * drawing instead of leaving it quietly lying.
 *
 * ONE ACCENT. Cyan is the machine: the flat line and its label. The other bill
 * is hairline white. Identity never rests on that — both series are named in the
 * legend above and listed in the table below.
 */

const W = 1160;
const H = 520;
const CYAN = accentVar("cyan");
const OTHER = "rgba(255,255,255,0.62)";

/* ── the numbers, once ─────────────────────────────────────────────────────── */

const SERIES = growthSeries();
const N = TIMELINE_MONTHS;
const CROSS = crossoverMonth(SERIES);
const UPGRADE = boxUpgradeMonth(SERIES);
const PEAK_EL = SERIES[SERIES.length - 1].el;
const MAX = Math.max(...SERIES.map((p) => Math.max(p.el, p.boxUsd)));

/** "Graviton t4g.small (2 vCPU)" → "t4g.small". The legend and the table carry
 *  the full preset name; a diagram annotation gets the part that identifies it. */
const short = (name: string) => name.replace(/^Graviton\s+/, "").replace(/\s*\(.*\)$/, "");

/* ── geometry, scaled by those numbers ─────────────────────────────────────── */

const X0 = 92;
const X1 = 1078;
const TOP = 96; // y of the largest bill in the span
const BASE = 430; // y of $0
const RULER = 452; // the time axis, held clear of the value floor
const at = (month: number) => X0 + ((month - 1) / (N - 1)) * (X1 - X0);
const y = (usd: number) => BASE - (usd / MAX) * (BASE - TOP);
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * A monthly bill as a STAIRCASE.
 *
 * Not a smooth curve: neither of these is metered. A subscription tier is a
 * price you are IN for a whole month and then step out of, so the riser sits
 * exactly on the month the volume crossed — which is what makes the crossing
 * point a real intersection rather than an interpolation artefact.
 */
function stair(pick: (p: GrowthPoint) => number) {
  const parts = [`M${r2(at(1))} ${r2(y(pick(SERIES[0])))}`];
  for (let i = 1; i < SERIES.length; i++) {
    const prev = y(pick(SERIES[i - 1]));
    const cur = y(pick(SERIES[i]));
    parts.push(`L${r2(at(i + 1))} ${r2(prev)}`, `L${r2(at(i + 1))} ${r2(cur)}`);
  }
  return parts.join(" ");
}

const EL_PATH = stair((p) => p.el);
const BOX_PATH = stair((p) => p.boxUsd);

/* Choreography — the ruler sweeps, both bills draw across one window, the
 * conclusions land after. The caption arrives inside 3 seconds. */
const T_RULER = 0.15;
const T_DRAW = 0.4;
const D_DRAW = 1.7;
const T_BAND = 0.7;
const T_CROSS = CROSS === null ? T_DRAW : T_DRAW + ((CROSS - 1) / (N - 1)) * D_DRAW + 0.1;
const T_END = T_DRAW + D_DRAW;
const T_CAP = T_END + 0.35;

/**
 * The usage read-out: the number the whole picture is a function of, counting up
 * along the exact curve the lines are drawn from.
 *
 * It writes through a ref instead of React state — sixty renders a second of a
 * whole section to move one number is not a trade worth making — and the markup
 * it ships with is the FINAL value, so the server, the still render and a
 * failed animation all show a true figure rather than a zero.
 */
function UsageReadout({ still }: { still: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (still || !node) return;
    node.textContent = START_CHARS.toLocaleString("en-US");
    const controls = animate(1, N, {
      delay: T_DRAW,
      duration: D_DRAW,
      ease: EASE,
      onUpdate: (m) => {
        node.textContent = usageAt(m).toLocaleString("en-US");
      },
      onComplete: () => {
        node.textContent = END_CHARS.toLocaleString("en-US");
      },
    });
    return () => controls.stop();
  }, [still]);
  return (
    <span ref={ref} className="font-instrument text-2xl tabular-nums text-white sm:text-3xl">
      {END_CHARS.toLocaleString("en-US")}
    </span>
  );
}

export default function PricingSignal({ still }: { still: boolean }) {
  return (
    <div>
      {/* The chart's title and its live read-out live OUT here, in text, at a
          size a person reads — the drawing gets six labels and no more. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/45">
          cost per month · {N} months
        </span>
        <span className="font-jetbrains flex items-baseline gap-2 text-[11px] uppercase tracking-widest text-white/45">
          usage this month
          <UsageReadout still={still} />
          chars
        </span>
      </div>

      <Illus w={W} h={H} className="mt-2">
        {/* ── the months ───────────────────────────────────────────────────── */}
        <Draw
          d={`M${X0} ${RULER} H${X1}`}
          delay={T_RULER}
          duration={0.55}
          stroke="rgba(255,255,255,0.10)"
          width={1}
          still={still}
        />
        {SERIES.map((p, i) => (
          <Draw
            key={p.month}
            d={`M${r2(at(p.month))} ${RULER} V${RULER + 6}`}
            delay={T_RULER + i * 0.018}
            duration={0.12}
            stroke={HAIR}
            width={1}
            still={still}
          />
        ))}
        <Label x={X0} y={478} size={11} delay={T_RULER + 0.2} still={still}>
          {`month 1 · ${fmtChars(START_CHARS)} chars/mo`}
        </Label>
        <Label x={X1} y={478} anchor="end" size={11} delay={T_RULER + 0.5} still={still}>
          {`month ${N} · ${fmtChars(END_CHARS)} chars/mo`}
        </Label>

        {/* ── the months where the subscription is the cheaper bill ────────── */}
        {CROSS !== null && CROSS > 1 && (
          <motion.rect
            x={r2(at(1))}
            y={TOP}
            width={r2(at(CROSS) - at(1))}
            height={RULER - TOP}
            fill="rgba(255,255,255,0.035)"
            initial={still ? { opacity: 1 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={still ? undefined : { delay: T_BAND, duration: 0.5, ease: EASE }}
          />
        )}

        {/* ── the subscription: a step per tier the growing volume enters ──── */}
        <Draw d={EL_PATH} delay={T_DRAW} duration={D_DRAW} stroke={OTHER} width={2} still={still} />
        <TravelPulse
          d={EL_PATH}
          delay={T_DRAW}
          duration={D_DRAW}
          color="rgba(255,255,255,0.9)"
          size={5}
          still={still}
        />
        {/* Their line starts ON the floor: month 1 fits inside the free tier. */}
        <Node x={at(1)} y={y(SERIES[0].el)} r={3.5} delay={T_DRAW} still={still} />
        <Label x={X1} y={TOP - 16} anchor="end" size={13} delay={T_END} still={still}>
          {`elevenlabs · ${fmtUsd(PEAK_EL)}/mo`}
        </Label>

        {/* ── the machine: one line, one price, all 24 months ──────────────── */}
        <Draw d={BOX_PATH} delay={T_DRAW} duration={D_DRAW} stroke={CYAN} width={2} still={still} />
        <TravelPulse d={BOX_PATH} delay={T_DRAW} duration={D_DRAW} color={CYAN} size={5} still={still} />
        <Label
          x={X1}
          y={r2(y(BOX_USD_MONTH)) - 14}
          anchor="end"
          size={13}
          accent="cyan"
          delay={T_END}
          still={still}
        >
          {`one ${short(SERIES[0].box.name)} · ${fmtUsd(BOX_USD_MONTH)}/mo`}
        </Label>

        {/* ── the crossing, marked where it actually happens ───────────────── */}
        {CROSS !== null && (
          <>
            <Label x={X0 + 4} y={386} size={11} delay={T_BAND + 0.15} still={still}>
              {`elevenlabs is cheaper · months 1-${CROSS - 1}`}
            </Label>
            <Draw
              d={`M${r2(at(CROSS))} ${RULER} V${r2(y(BOX_USD_MONTH)) - 6}`}
              delay={T_CROSS}
              duration={0.35}
              stroke={HAIR}
              width={1}
              still={still}
            />
            <Node x={at(CROSS)} y={y(BOX_USD_MONTH)} r={4} accent="cyan" delay={T_CROSS + 0.2} still={still} />
            <Label x={at(CROSS)} y={500} anchor="middle" size={11} delay={T_CROSS + 0.3} still={still}>
              {`they cross · month ${CROSS}`}
            </Label>
          </>
        )}

        {/* ── and if the volume ever outgrew the box, the riser that costs ─── */}
        {UPGRADE !== null && (
          <Node
            x={at(UPGRADE)}
            y={y(SERIES[UPGRADE - 1].boxUsd)}
            r={4}
            accent="cyan"
            delay={T_END}
            still={still}
          />
        )}
      </Illus>

      <Caption delay={T_CAP} still={still}>
        One bill grows with the usage; the other is the same machine every month —{" "}
        {fmtUsd(BOX_USD_MONTH)}, asleep or busy. Which is also why, for the first{" "}
        {CROSS === null ? N : CROSS - 1} months here, the machine is the worse buy.
      </Caption>
    </div>
  );
}
