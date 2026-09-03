"use client";

/*
 * The illustration vocabulary — the one toolbox every feature spotlight is
 * composed from.
 *
 * WHAT IT IS. Oscilloscope: near-monochrome hairlines on ink, ONE accent per
 * diagram, everything drawn — <Draw>, <TravelPulse>, <WaveLine>, <Label>,
 * <Node>, inside an <Illus> canvas, ending on one <Caption>. A spotlight is a
 * PICTURE of its mechanism with the prose demoted to that single caption.
 *
 * It replaced a vocabulary of ROWS — a stack of labelled lines that popped in —
 * which could only ever produce step-by-step text, because a row is a sentence
 * with a border. Nothing of that survives; there is one house style here, and a
 * new spotlight matches it.
 *
 * MOTION AUSTERITY. Every entrance is entry-only. A pulse travels its path ONCE
 * and fades at arrival; nothing here loops, because a spotlight is opened
 * deliberately and then read.
 *
 * STILL-AWARENESS is the same rule everywhere: `still` gates the animation and
 * never drops the element. A stilled <Draw> is a finished stroke; a stilled
 * <TravelPulse> is a dot parked at its destination — the picture still says the
 * same thing, it just says it all at once.
 *
 * DASH GEOMETRY. Both <Draw> and <TravelPulse> set `pathLength={1}`, which
 * renormalises every dash unit to a fraction of the path. That is what lets a
 * dash-draw and a travelling dot share one `d` string with no measurement, no
 * getTotalLength, and no layout read — so they work identically in jsdom, on
 * the server, and before fonts load.
 *
 * No colour literals here; accents come from the `--gt-accent-*` vars via
 * `accentVar` (components/ui/tokens.ts is the one file allowed to hold a hex).
 */
import type { CSSProperties, ReactNode } from "react";
import { motion } from "framer-motion";
import { EASE } from "@/components/ui/tokens";
import { wavePath, type WaveOpts } from "./illusGeometry";

/* The waveform arithmetic lives in ./illusGeometry — pure, and separately
 * tested — but it is part of this vocabulary's surface, so it leaves through
 * this file like everything else. */
export { wavePath };
export type { WaveOpts };

export type Accent = "cyan" | "violet" | "emerald";

/** The CSS var behind an accent name, for inline SVG strokes and glows. */
export const accentVar = (a: Accent) => `var(--gt-accent-${a})`;

/** Hairline white, the recessive stroke every diagram draws its structure in. */
export const HAIR = "rgba(255,255,255,0.14)";

/* ══════════════════════════════ svg canvas ════════════════════════════════ */

/**
 * The sized canvas every illustration lives in.
 *
 * Fixed user-unit viewBox, fluid on screen — so a composition is authored in
 * one coordinate space and the surface decides how big it renders.
 *
 * `h` is a BUDGET SET BY THE SURFACE, not by this file. A feature SPOTLIGHT is
 * `max-h-[85vh]` and MUST NOT SCROLL on a 1280×800 laptop, which leaves roughly
 * 500 CSS px for the whole body: keep those at or under 380. A LANDING-SECTION
 * illustration has the whole content column and scrolls with the page, so it may
 * run landscape and larger (PricingBills is 1160×560) — the constraint there is
 * the composition's own, not the modal's. See DESIGN.md, "Scale is a property of
 * the surface".
 */
export function Illus({
  w,
  h,
  grid = false,
  className = "",
  children,
}: {
  w: number;
  h: number;
  /** Faint 24-unit graticule behind the drawing — the scope's own paper. */
  grid?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={`w-full ${className}`}
      style={{ maxHeight: `${h}px` }}
      // The picture is the argument, but it is a picture: the caption under it
      // and the card copy behind it carry the same claim in text.
      aria-hidden
      preserveAspectRatio="xMidYMid meet"
    >
      {grid && (
        <>
          <defs>
            <pattern id="gt-graticule" width="24" height="24" patternUnits="userSpaceOnUse">
              <path d="M24 0H0V24" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width={w} height={h} fill="url(#gt-graticule)" />
        </>
      )}
      {children}
    </svg>
  );
}

/* ══════════════════════════════ signal primitives ═════════════════════════ */

type DrawProps = {
  d: string;
  delay?: number;
  duration?: number;
  /** Any CSS colour; pass `accentVar("cyan")` for the one accent. */
  stroke?: string;
  width?: number;
  opacity?: number;
  /** Render the stroke dashed once drawn — for a route not taken, a boundary. */
  dashed?: boolean;
  fill?: string;
  still?: boolean;
  className?: string;
  style?: CSSProperties;
};

/**
 * A path that draws itself. The workhorse of the whole vocabulary.
 *
 * `pathLength={1}` makes the dash units fractions of the path, so one
 * dashoffset tween from 1 → 0 draws any path, of any length, in the given
 * duration. Stilled, it is simply the finished stroke.
 */
export function Draw({
  d,
  delay = 0,
  duration = 0.9,
  stroke = HAIR,
  width = 1.5,
  opacity = 1,
  dashed = false,
  fill = "none",
  still = false,
  className = "",
  style,
}: DrawProps) {
  const common = {
    d,
    fill,
    stroke,
    strokeWidth: width,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    pathLength: 1,
    className,
    style,
  };
  if (still) {
    return <path {...common} opacity={opacity} strokeDasharray={dashed ? "0.012 0.014" : undefined} />;
  }
  return (
    <motion.path
      {...common}
      strokeDasharray={dashed ? "0.012 0.014" : "1 1"}
      initial={{ strokeDashoffset: dashed ? 0 : 1, opacity: dashed ? 0 : opacity }}
      animate={{ strokeDashoffset: 0, opacity }}
      transition={{ delay, duration, ease: EASE }}
    />
  );
}

/**
 * A dot travelling along a path, once, then gone.
 *
 * Implemented as a one-dash stroke rather than `offset-path`: the dot is
 * guaranteed to sit exactly on the line, in every engine, with no second copy
 * of the geometry to keep in sync. `size` is the stroke width, so the dot has
 * the line's own weight and reads as the signal moving rather than as a
 * sprite on top of it.
 */
export function TravelPulse({
  d,
  delay = 0,
  duration = 1.1,
  color = accentVar("cyan"),
  size = 5,
  /** Where the stilled dot parks, 0 (start) … 1 (end). Default 1 — arrived. */
  restAt = 1,
  still = false,
}: {
  d: string;
  delay?: number;
  duration?: number;
  color?: string;
  size?: number;
  restAt?: number;
  still?: boolean;
}) {
  const common = {
    d,
    fill: "none",
    stroke: color,
    strokeWidth: size,
    strokeLinecap: "round" as const,
    pathLength: 1,
    // A dot: a dash short enough to be a round cap, and a gap longer than the
    // path so no second dot enters behind it.
    strokeDasharray: "0.001 2",
  };
  if (still) return <path {...common} strokeDashoffset={-restAt} opacity={0.9} />;
  return (
    <motion.path
      {...common}
      initial={{ strokeDashoffset: 0, opacity: 0 }}
      animate={{ strokeDashoffset: [0, -1], opacity: [0, 0.95, 0.95, 0] }}
      transition={{ delay, duration, ease: "easeInOut", times: [0, 0.12, 0.82, 1] }}
      style={{ filter: `drop-shadow(0 0 6px ${color})` }}
    />
  );
}

/**
 * A waveform that draws itself, and can morph into another waveform.
 *
 * `morphTo` is the split/transform verb of the vocabulary: give it a
 * second set of wave options with the SAME `points` and the line will travel
 * from one shape to the other after it has finished drawing. Stilled, it
 * renders the destination shape — the end of the story, held.
 */
export function WaveLine({
  wave,
  morphTo,
  delay = 0,
  duration = 0.9,
  /** Beats to hold the drawn shape before morphing. Default 0.35. */
  hold = 0.35,
  morphDuration = 0.8,
  stroke = HAIR,
  width = 1.6,
  opacity = 1,
  still = false,
}: {
  wave: WaveOpts;
  morphTo?: WaveOpts;
  delay?: number;
  duration?: number;
  hold?: number;
  morphDuration?: number;
  stroke?: string;
  width?: number;
  opacity?: number;
  still?: boolean;
}) {
  const from = wavePath(wave);
  const to = morphTo ? wavePath(morphTo) : null;
  if (still) return <Draw d={to ?? from} stroke={stroke} width={width} opacity={opacity} still />;
  if (!to) {
    return (
      <Draw d={from} delay={delay} duration={duration} stroke={stroke} width={width} opacity={opacity} />
    );
  }
  // Two paths, one handoff. The first DRAWS the source shape and then hands
  // over — at the instant it hides, the second is still sitting on exactly the
  // same `d`, so the swap is invisible and the morph starts from a shape the
  // eye has already read.
  const handoff = delay + duration;
  return (
    <>
      <motion.path
        d={from}
        fill="none"
        stroke={stroke}
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        strokeDasharray="1 1"
        initial={{ strokeDashoffset: 1, opacity }}
        animate={{ strokeDashoffset: 0, opacity: [opacity, opacity, 0] }}
        transition={{
          strokeDashoffset: { delay, duration, ease: EASE },
          opacity: { delay: handoff, duration: 0.01, times: [0, 0.5, 1] },
        }}
      />
      <motion.path
        fill="none"
        stroke={stroke}
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ d: from, opacity: 0 }}
        animate={{ d: to, opacity }}
        transition={{
          d: { delay: handoff + hold, duration: morphDuration, ease: EASE },
          opacity: { delay: handoff, duration: 0.01 },
        }}
      />
    </>
  );
}

/**
 * A micro-label inside the drawing. THREE WORDS MAX — if a scene needs a
 * sentence, the scene is wrong. Monospace and small, so it reads as an
 * annotation on a diagram and never competes with the line it names.
 */
export function Label({
  x,
  y,
  children,
  anchor = "start",
  accent,
  delay = 0,
  size = 9,
  still = false,
}: {
  x: number;
  y: number;
  children: string;
  anchor?: "start" | "middle" | "end";
  /** Omit for the recessive white; pass an accent to make the label part of
   *  the one coloured story the diagram is telling. */
  accent?: Accent;
  delay?: number;
  size?: number;
  still?: boolean;
}) {
  const fill = accent ? accentVar(accent) : "rgba(255,255,255,0.42)";
  return (
    <motion.text
      x={x}
      y={y}
      textAnchor={anchor}
      className="font-jetbrains uppercase"
      style={{ fontSize: size, letterSpacing: "0.14em", fill }}
      initial={still ? { opacity: 1 } : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={still ? undefined : { delay, duration: 0.4 }}
    >
      {children}
    </motion.text>
  );
}

/** A dot on a path — a station, a tap point, a junction. */
export function Node({
  x,
  y,
  r = 3.5,
  accent,
  delay = 0,
  still = false,
}: {
  x: number;
  y: number;
  r?: number;
  accent?: Accent;
  delay?: number;
  still?: boolean;
}) {
  const c = accent ? accentVar(accent) : "rgba(255,255,255,0.55)";
  // The radius ATTRIBUTE, not a scale transform: an SVG transform needs a
  // transform-origin/transform-box pair to be reliable across engines, and a
  // circle already has a first-class size channel.
  return (
    <motion.circle
      cx={x}
      cy={y}
      fill={c}
      initial={still ? { r, opacity: 1 } : { r: r * 0.2, opacity: 0 }}
      animate={{ r, opacity: 1 }}
      transition={still ? undefined : { delay, type: "spring", bounce: 0.5, duration: 0.55 }}
    />
  );
}

/* ══════════════════════════════ the one line of prose ═════════════════════ */

/**
 * The caption. ONE line, under the picture, secondary by construction.
 *
 * It is deliberately the only prose primitive in this file: if a spotlight needs
 * two of these, the illustration is not carrying the story and the fix is in
 * the drawing, not here. The honest limit each feature ships with is usually
 * what this line spends itself on — the picture shows the mechanism, the
 * caption names the cost.
 */
export function Caption({
  children,
  delay = 1,
  still = false,
}: {
  children: ReactNode;
  delay?: number;
  still?: boolean;
}) {
  return (
    <motion.p
      initial={still ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={still ? undefined : { delay, duration: 0.45, ease: EASE }}
      className="mx-auto mt-3 max-w-md text-center text-[12.5px] leading-relaxed text-slate-300/70"
    >
      {children}
    </motion.p>
  );
}
