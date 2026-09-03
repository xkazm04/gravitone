"use client";

import { motion } from "framer-motion";
import { fmtUsd } from "@/lib/switchkit";
import { EASE } from "@/components/ui/tokens";
import {
  BOX,
  BOX_USD_MONTH,
  END_CHARS,
  START_CHARS,
  fmtChars,
} from "./pricingTimeline";
import {
  BOX_PATH,
  BOX_SLAB,
  BOX_STEPS,
  D_RUN,
  EL_PATH,
  EL_SLAB,
  EL_STEPS,
  H,
  MONTHLY_CROSS,
  N,
  SERIES,
  TOP,
  TOTALS,
  TOTAL_CROSS,
  T_CAP,
  T_MONTHLY_CROSS,
  T_RUN,
  T_SWAP,
  T_ZERO,
  W,
  X0,
  X1,
  ZERO,
  at,
  down,
  r2,
  short,
  up,
} from "./pricingBillsMath";
import { Increment, Odometer } from "./PricingBillsOdometer";
import { Caption, Draw, HAIR, Illus, Label, Node, TravelPulse, accentVar } from "./features/previews/illus";

/*
 * switch · VARIANT A — "THE TWO BILLS".
 *
 * THE MENTAL MODEL: accumulation as a physical object. Not two lines on a
 * chart — two BILLS, each one a stack of monthly charges that gets thicker as
 * the months land on it. The hero is the running total, because a running total
 * is the number a person actually ends up paying, and the picture underneath is
 * that total's shape rather than a second reading of it.
 *
 * WHY THE NUMBERS ARE THE PICTURE. Two odometers count 24 months of billing in
 * about two seconds. Theirs takes bigger and bigger steps as the volume climbs
 * tiers — the increment under it re-reads $0 → $5 → $22 → $99 → $330 — and ours
 * takes the same $12.26 step twenty-four times, because a rented machine bills
 * 730 hours whether or not it speaks. You do not have to read an axis to see
 * that; you watch one counter accelerate away from the other.
 *
 * THE DRAWING IS THE BILLS' FOOTPRINT, mirrored about the $0 line: their
 * monthly charge grows upward, ours downward, on ONE shared dollar scale. The
 * two filled slabs are literally the two totals — area IS money here — so the
 * ratio the odometers land on ($3,133 against $294) is the ratio of ink on the
 * screen. Months 1–5 need no wash and no apology: their slab is visibly THINNER
 * than ours there, which is the same fact the deleted paragraph spent 90 words
 * on.
 *
 * TWO CROSSINGS, AND THEY ARE NOT THE SAME MONTH. Month 6 is where the monthly
 * charge crosses — from there on every further month is cheaper on the machine.
 * The TOTALS do not cross until month 10, because the machine spent five months
 * in front and that debt has to be repaid. The odometers swap visual dominance
 * at 10, not at 6 (pricingTimeline::cumulativeCrossoverMonth exists to keep
 * those two apart, and has a test that fails if they ever merge).
 *
 * ONE ACCENT — cyan is the machine, everywhere on this page. Identity never
 * rests on it: both bills are named in words directly above their own number.
 *
 * The series, the coordinate space and the clock are derived in
 * ./pricingBillsMath; the two counting numbers are ./PricingBillsOdometer. What
 * is left here is the composition.
 */

const CYAN = accentVar("cyan");
const OTHER = "rgba(255,255,255,0.62)";
const EL_FILL = "rgba(255,255,255,0.05)";

/**
 * One bill: who it is, what it has cost, and the step it takes each month.
 *
 * `lead` is the dominance swap. Until the totals cross, the machine's plate is
 * the bigger one on the screen and the subscription's is recessed — which is
 * the truth in those months and the reason the honesty paragraph existed. At
 * the crossing they trade places, once, and hold.
 */
function Plate({
  name,
  sub,
  total,
  increment,
  accent,
  leadsFirst,
  still,
  align,
}: {
  name: string;
  sub: string;
  total: React.ReactNode;
  increment: React.ReactNode;
  accent: boolean;
  leadsFirst: boolean;
  still: boolean;
  align: "left" | "right";
}) {
  const from = leadsFirst ? { opacity: 1, scale: 1 } : { opacity: 0.5, scale: 0.88 };
  const to = leadsFirst ? { opacity: 0.78, scale: 0.88 } : { opacity: 1, scale: 1 };
  return (
    <motion.div
      className={align === "right" ? "text-right" : ""}
      style={{ transformOrigin: align === "right" ? "right bottom" : "left bottom" }}
      initial={still ? to : from}
      animate={to}
      transition={still ? undefined : { delay: T_SWAP, duration: 0.7, ease: EASE }}
    >
      <div className="font-jetbrains text-[11px] uppercase tracking-widest text-white/55">{name}</div>
      <div
        className="font-instrument text-4xl leading-none tabular-nums sm:text-6xl"
        style={{ color: accent ? CYAN : "#fff" }}
      >
        {total}
      </div>
      <div className="font-jetbrains mt-1.5 text-[11px] tabular-nums text-white/45">
        {increment}
        <span className="text-white/30"> · {sub}</span>
      </div>
    </motion.div>
  );
}

/* ── the composition ───────────────────────────────────────────────────────── */

const CLIP = "gt-bills-sweep";

export default function PricingBills({ still }: { still: boolean }) {
  return (
    <div>
      {/* The two totals, at the size a person reads a price. The plates carry
          their own names, so the drawing below needs no legend inside it. */}
      <div className="flex items-end justify-between gap-6">
        <Plate
          name="ElevenLabs · 24 months"
          sub="this month"
          total={<Odometer steps={EL_STEPS} still={still} className="tabular-nums" />}
          increment={<Increment still={still} />}
          accent={false}
          leadsFirst={false}
          still={still}
          align="left"
        />
        <Plate
          name={`${short(BOX.name)} · 24 months`}
          sub="every month, 730 h"
          total={<Odometer steps={BOX_STEPS} still={still} className="tabular-nums" />}
          increment={<>+{fmtUsd(BOX_USD_MONTH)}</>}
          accent
          leadsFirst
          still={still}
          align="right"
        />
      </div>

      <Illus w={W} h={H} className="mt-5">
        <defs>
          {/* One sweep reveals both slabs, on the draw's own curve, so the fill
              can never run ahead of the stroke that bounds it. */}
          <clipPath id={CLIP}>
            <motion.rect
              x={X0}
              y={0}
              height={H}
              initial={still ? { width: X1 - X0 } : { width: 0 }}
              animate={{ width: X1 - X0 }}
              transition={still ? undefined : { delay: T_RUN, duration: D_RUN, ease: EASE }}
            />
          </clipPath>
        </defs>

        {/* ── $0: the software's own price, and the axis both bills grow from ── */}
        <Draw
          d={`M${X0} ${ZERO} H${X1}`}
          delay={T_ZERO}
          duration={0.6}
          stroke="rgba(255,255,255,0.10)"
          width={1}
          still={still}
        />
        {SERIES.map((p, i) => (
          <Draw
            key={p.month}
            d={`M${r2(at(p.month))} ${ZERO - 3} V${ZERO + 3}`}
            delay={T_ZERO + i * 0.014}
            duration={0.1}
            stroke={HAIR}
            width={1}
            still={still}
          />
        ))}

        {/* ── the two slabs: area is money, on one shared scale ─────────────── */}
        <g clipPath={`url(#${CLIP})`}>
          <path d={EL_SLAB} fill={EL_FILL} stroke="none" />
          <path d={BOX_SLAB} fill={CYAN} fillOpacity={0.16} stroke="none" />
        </g>
        <Draw d={EL_PATH} delay={T_RUN} duration={D_RUN} stroke={OTHER} width={2} still={still} />
        <Draw d={BOX_PATH} delay={T_RUN} duration={D_RUN} stroke={CYAN} width={2} still={still} />
        <TravelPulse d={EL_PATH} delay={T_RUN} duration={D_RUN} color="rgba(255,255,255,0.9)" size={5} still={still} />
        <TravelPulse d={BOX_PATH} delay={T_RUN} duration={D_RUN} color={CYAN} size={5} still={still} />

        {/* ── the month the MONTHLY charge crosses ──────────────────────────── */}
        {MONTHLY_CROSS !== null && (
          <>
            <Node x={at(MONTHLY_CROSS)} y={up(SERIES[MONTHLY_CROSS - 1].el)} r={4} delay={T_MONTHLY_CROSS} still={still} />
            <Label
              x={at(MONTHLY_CROSS) + 8}
              y={up(SERIES[MONTHLY_CROSS - 1].el) - 10}
              size={11}
              delay={T_MONTHLY_CROSS + 0.1}
              still={still}
            >
              {`month ${MONTHLY_CROSS} · the month flips`}
            </Label>
          </>
        )}

        {/* ── and the later month the TOTALS cross: the debt repaid ─────────── */}
        {TOTAL_CROSS !== null && (
          <>
            <Draw
              d={`M${r2(at(TOTAL_CROSS))} ${TOP + 6} V${r2(down(BOX_USD_MONTH)) + 26}`}
              delay={T_SWAP}
              duration={0.4}
              stroke={CYAN}
              width={1}
              still={still}
            />
            <Node x={at(TOTAL_CROSS)} y={ZERO} r={4} accent="cyan" delay={T_SWAP + 0.1} still={still} />
            <Label
              x={at(TOTAL_CROSS) + 8}
              y={down(BOX_USD_MONTH) + 38}
              size={11}
              accent="cyan"
              delay={T_SWAP + 0.15}
              still={still}
            >
              {`month ${TOTAL_CROSS} · the totals cross`}
            </Label>
          </>
        )}

        {/* ── the span, and the growth that drives it ───────────────────────── */}
        <Label x={X0} y={ZERO + 22} size={11} delay={T_ZERO + 0.2} still={still}>
          {`month 1 · ${fmtChars(START_CHARS)} chars/mo`}
        </Label>
        <Label x={X1} y={ZERO + 22} anchor="end" size={11} delay={T_ZERO + 0.4} still={still}>
          {`month ${N} · ${fmtChars(END_CHARS)} chars/mo`}
        </Label>
        {/* The floor is not empty space: it is the software's price. */}
        <Label x={X0} y={ZERO - 9} size={11} accent="cyan" delay={T_ZERO + 0.3} still={still}>
          gravitone · $0 · mit
        </Label>
      </Illus>

      <Caption delay={T_CAP} still={still}>
        {fmtUsd(TOTALS.el)} against {fmtUsd(TOTALS.box)} over {N} months — and the machine is the
        thicker bill for the first {MONTHLY_CROSS === null ? N : MONTHLY_CROSS - 1}.
      </Caption>
    </div>
  );
}
