"use client";

import { useEffect, useRef } from "react";
import { animate, motion } from "framer-motion";
import { fmtUsd } from "@/lib/switchkit";
import { EASE } from "@/components/ui/tokens";
import {
  BOX,
  BOX_USD_MONTH,
  END_CHARS,
  START_CHARS,
  TIMELINE_MONTHS,
  crossoverMonth,
  fmtChars,
  growthSeries,
  growthTotals,
  tierSteps,
  usageAt,
} from "./pricingTimeline";
import { easedTimeFor } from "./pricingShared";
import { Caption, Draw, HAIR, Illus, Label, Node, TravelPulse, accentVar } from "./features/previews/illus";

/*
 * switch · VARIANT B — "THE CLIMB".
 *
 * THE MENTAL MODEL: the tier ladder as TERRAIN, and the machine as a road built
 * across it at one altitude.
 *
 * The published ElevenLabs tiers are a staircase of ground rising under a
 * project as it grows — each step is a tier, its height IS its price, and it is
 * labelled with the tier's own name and figure (the sanctioned citation; every
 * one of them comes out of lib/switchkit.ts and none is retyped here). The
 * always-on Arm box is a flat causeway at $12.26 running the whole width at one
 * altitude, because the machine's price does not care what month it is.
 *
 * THE COMPARISON IS AN ALTITUDE, not a legend lookup. A traveller climbs the
 * terrain month by month with the usage read-out ticking beside it; whether it
 * is above or below the causeway is the whole answer. For the first five months
 * the ground is UNDER the road — the free tier is literally the floor and
 * Starter is barely off it — so the honest valley is not a wash we added to
 * look fair, it is what the terrain does. From month 6 the climb crosses the
 * causeway and never comes back down.
 *
 * THE PAYOFF IS TWO STAMPS. What each side cost across the whole span appears
 * once, at the end, after the climb has finished — a conclusion, not a running
 * commentary. Everything before that is geography.
 *
 * ONE ACCENT: cyan is the machine and its road; the terrain is hairline.
 *
 * THE LABEL BUDGET is spent almost entirely on the ladder, and deliberately.
 * Three tiers are named where they stand — the ones ABOVE the road, which is
 * where a step's height is the argument. The two below it are named ONCE, in
 * the valley caption under them, because there the price is not the point: that
 * they are under the road is. Eight text elements in total, which is the arm's-
 * length ceiling; the totals are stamped in HTML underneath rather than inside
 * the drawing, which is what keeps it at eight.
 */

const W = 1160;
const H = 560;
const CYAN = accentVar("cyan");
const OTHER = "rgba(255,255,255,0.62)";
const TERRAIN_FILL = "rgba(255,255,255,0.045)";

/* ── the numbers, once ─────────────────────────────────────────────────────── */

const SERIES = growthSeries();
const STEPS = tierSteps(SERIES);
const TOTALS = growthTotals(SERIES);
const N = TIMELINE_MONTHS;
const CROSS = crossoverMonth(SERIES);
/** The tallest ground in the span — the scale everything is drawn at. */
const PEAK = Math.max(...SERIES.map((p) => p.el));

const short = (name: string) => name.replace(/^Graviton\s+/, "").replace(/\s*\(.*\)$/, "");

/* ── geometry, scaled by those numbers ─────────────────────────────────────── */

const X0 = 56;
const X1 = 1104;
const BASE = 470; // $0 — the ground the free tier sits on
const TOP = 90; // the top tier's altitude
const RULER = 492;
/** Month `m` occupies the ground from bx(m) to bx(m+1): each month is a tile. */
const bx = (month: number) => X0 + ((month - 1) / N) * (X1 - X0);
const y = (usd: number) => BASE - (usd / PEAK) * (BASE - TOP);
const r2 = (v: number) => Math.round(v * 100) / 100;

const ROAD_Y = y(BOX_USD_MONTH);

/** The terrain's skyline: one plateau per tier, one riser between. */
const TERRAIN = (() => {
  const parts = [`M${r2(X0)} ${r2(y(STEPS[0].tier.usdPerMonth))}`];
  for (const step of STEPS) {
    parts.push(`L${r2(bx(step.fromMonth))} ${r2(y(step.tier.usdPerMonth))}`);
    parts.push(`L${r2(bx(step.toMonth + 1))} ${r2(y(step.tier.usdPerMonth))}`);
  }
  return parts.join(" ");
})();
const TERRAIN_MASS = `${TERRAIN} L${r2(X1)} ${BASE} L${r2(X0)} ${BASE} Z`;
const ROAD = `M${X0} ${r2(ROAD_Y)} H${X1}`;

/* ── choreography ──────────────────────────────────────────────────────────── */

const T_GROUND = 0.2;
const D_GROUND = 1.3;
const T_ROAD = 0.55;
const T_CLIMB = 0.9;
const D_CLIMB = 1.5;
const T_VALLEY = 1.0;
const T_CROSS = CROSS === null ? T_CLIMB : T_CLIMB + easedTimeFor((CROSS - 1) / N) * D_CLIMB;
const T_STAMP = T_CLIMB + D_CLIMB;
const T_CAP = T_STAMP + 0.35;

/* ── the traveller's read-out ──────────────────────────────────────────────── */

/**
 * What the project is generating as it climbs.
 *
 * Written through a ref, not through state: sixty renders a second of a whole
 * landing section to move one number is not a trade worth making. The markup it
 * ships with is the FINAL value, so the server, a stilled render and a failed
 * animation all show a true figure rather than a zero.
 */
function UsageReadout({ still }: { still: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (still || !node) return;
    node.textContent = START_CHARS.toLocaleString("en-US");
    const controls = animate(1, N, {
      delay: T_CLIMB,
      duration: D_CLIMB,
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

/** A total, stamped once the climb is over. */
function Stamp({
  name,
  value,
  accent,
  still,
  align,
}: {
  name: string;
  value: string;
  accent: boolean;
  still: boolean;
  align: "left" | "right";
}) {
  return (
    <motion.div
      className={align === "right" ? "text-right" : ""}
      initial={still ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.86 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={still ? undefined : { delay: T_STAMP, type: "spring", bounce: 0.42, duration: 0.6 }}
      style={{ transformOrigin: align === "right" ? "right center" : "left center" }}
    >
      <div className="font-jetbrains text-[11px] uppercase tracking-widest text-white/50">{name}</div>
      <div
        className="font-instrument text-4xl leading-none tabular-nums sm:text-5xl"
        style={{ color: accent ? CYAN : "#fff" }}
      >
        {value}
      </div>
    </motion.div>
  );
}

/* ── the composition ───────────────────────────────────────────────────────── */

const CLIP = "gt-climb-ground";

export default function PricingClimb({ still }: { still: boolean }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/45">
          the tier ladder as ground · {N} months
        </span>
        <span className="font-jetbrains flex items-baseline gap-2 text-[11px] uppercase tracking-widest text-white/45">
          usage this month
          <UsageReadout still={still} />
          chars
        </span>
      </div>

      <Illus w={W} h={H} className="mt-2">
        <defs>
          {/* The ground fills in behind its own skyline, on the same curve, so
              the mass can never run ahead of the line that bounds it. */}
          <clipPath id={CLIP}>
            <motion.rect
              x={X0}
              y={0}
              height={H}
              initial={still ? { width: X1 - X0 } : { width: 0 }}
              animate={{ width: X1 - X0 }}
              transition={still ? undefined : { delay: T_GROUND, duration: D_GROUND, ease: EASE }}
            />
          </clipPath>
        </defs>

        {/* ── the terrain: one step per published tier ──────────────────────── */}
        <g clipPath={`url(#${CLIP})`}>
          <path d={TERRAIN_MASS} fill={TERRAIN_FILL} stroke="none" />
        </g>
        <Draw d={TERRAIN} delay={T_GROUND} duration={D_GROUND} stroke={OTHER} width={2} still={still} />

        {/* ── the causeway: one altitude, all 24 months ─────────────────────── */}
        {/* The road deck, so it reads as something built across the terrain
            rather than as a gridline that happens to be cyan. */}
        <g clipPath={`url(#${CLIP})`}>
          <motion.rect
            x={X0}
            y={r2(ROAD_Y)}
            width={X1 - X0}
            height={5}
            fill={CYAN}
            fillOpacity={0.18}
            initial={still ? { opacity: 1 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={still ? undefined : { delay: T_ROAD + 0.4, duration: 0.5, ease: EASE }}
          />
        </g>
        <Draw d={ROAD} delay={T_ROAD} duration={0.9} stroke={CYAN} width={2} still={still} />

        {/* ── the valley: the months the ground is UNDER the road ───────────── */}
        {CROSS !== null && CROSS > 1 && (
          <motion.rect
            x={r2(bx(1))}
            y={r2(ROAD_Y)}
            width={r2(bx(CROSS) - bx(1))}
            height={r2(BASE - ROAD_Y)}
            fill={CYAN}
            fillOpacity={0.13}
            initial={still ? { opacity: 1 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={still ? undefined : { delay: T_VALLEY, duration: 0.5, ease: EASE }}
          />
        )}

        {/* ── the climb: the project travelling its own terrain ─────────────── */}
        <TravelPulse
          d={TERRAIN}
          delay={T_CLIMB}
          duration={D_CLIMB}
          color="rgba(255,255,255,0.95)"
          size={7}
          still={still}
        />
        {CROSS !== null && (
          <>
            <Node x={bx(CROSS)} y={ROAD_Y} r={5} accent="cyan" delay={T_CROSS} still={still} />
            <Draw
              d={`M${r2(bx(CROSS))} ${r2(ROAD_Y) + 8} V${RULER}`}
              delay={T_CROSS}
              duration={0.3}
              stroke={HAIR}
              width={1}
              still={still}
            />
          </>
        )}

        {/* ── the months ───────────────────────────────────────────────────── */}
        <Draw
          d={`M${X0} ${RULER} H${X1}`}
          delay={T_GROUND}
          duration={0.6}
          stroke="rgba(255,255,255,0.10)"
          width={1}
          still={still}
        />

        {/* ── the labels: the ladder is the citation, so the ladder is named ── */}
        {STEPS.filter((s) => s.tier.usdPerMonth > BOX_USD_MONTH).map((s, i) => (
          <Label
            key={s.tier.name}
            x={bx(s.fromMonth) + 8}
            y={r2(y(s.tier.usdPerMonth)) - 9}
            size={11}
            delay={T_GROUND + 0.5 + i * 0.12}
            still={still}
          >
            {`${s.tier.name.toLowerCase()} · ${fmtUsd(s.tier.usdPerMonth)}`}
          </Label>
        ))}
        <Label x={X1} y={r2(ROAD_Y) - 12} anchor="end" size={12} accent="cyan" delay={T_ROAD + 0.5} still={still}>
          {`one ${short(BOX.name)} · ${fmtUsd(BOX_USD_MONTH)}/mo`}
        </Label>
        <Label x={X0} y={512} size={11} delay={T_GROUND + 0.3} still={still}>
          {`month 1 · ${fmtChars(START_CHARS)} chars/mo`}
        </Label>
        {CROSS !== null && (
          <Label x={bx(CROSS) + 8} y={512} size={11} accent="cyan" delay={T_CROSS + 0.2} still={still}>
            {`month ${CROSS} · the climb crosses`}
          </Label>
        )}
        <Label x={X1} y={512} anchor="end" size={11} delay={T_GROUND + 0.6} still={still}>
          {`month ${N} · ${fmtChars(END_CHARS)} chars/mo`}
        </Label>
        {/* The valley named with the two tiers that make it — the same citation
            data, in the one place on the drawing where it is the point. */}
        {CROSS !== null && CROSS > 1 && (
          <Label x={X0} y={536} size={11} delay={T_VALLEY + 0.2} still={still}>
            {`months 1-${CROSS - 1} · ${STEPS.filter((s) => s.tier.usdPerMonth <= BOX_USD_MONTH)
              .map((s) => `${s.tier.name.toLowerCase()} ${fmtUsd(s.tier.usdPerMonth)}`)
              .join(" · ")}`}
          </Label>
        )}
      </Illus>

      {/* The conclusion, once, after the climb — not a running commentary. */}
      <div className="mt-4 flex items-end justify-between gap-6">
        <Stamp name="ElevenLabs · 24 months" value={fmtUsd(TOTALS.el)} accent={false} still={still} align="left" />
        <Stamp
          name={`${short(BOX.name)} · 24 months`}
          value={fmtUsd(TOTALS.box)}
          accent
          still={still}
          align="right"
        />
      </div>

      <Caption delay={T_CAP} still={still}>
        The tiers are ground that rises; the machine is a road at one altitude — under it for{" "}
        {CROSS === null ? N : CROSS - 1} months, over it ever after.
      </Caption>
    </div>
  );
}
