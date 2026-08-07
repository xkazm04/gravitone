"use client";

/*
 * The illustration vocabulary — the shared primitives the `signal` and `stage`
 * spotlight variants are composed from.
 *
 * WHY THIS FILE EXISTS. The shipped previews (`shared.tsx`) are a vocabulary of
 * ROWS: a stack of labelled lines that pop in. That vocabulary can only ever
 * produce step-by-step text, because a row is a sentence with a border. This
 * file is the other vocabulary — paths, pulses, waves, lanes and stages — so a
 * preview can be a PICTURE of its mechanism with the prose demoted to one
 * caption underneath.
 *
 * TWO DIRECTIONS, ONE TOOLBOX.
 *   signal — oscilloscope. Near-monochrome hairlines on ink, ONE accent per
 *     diagram, everything drawn: <Draw>, <TravelPulse>, <WaveLine>, <Label>.
 *   stage  — diorama. Actors arranged in depth, entering with the pop/stamp
 *     spring the house already uses: <Stage>, <Lane>, <Tag>.
 * Both end on one <Caption>.
 *
 * MOTION AUSTERITY holds (see shared.tsx): every entrance is entry-only. A
 * pulse travels its path ONCE and fades at arrival; nothing here loops, because
 * a spotlight is opened deliberately and then read.
 *
 * STILL-AWARENESS holds too, and it is the same rule everywhere: `still` gates
 * the animation and never drops the element. A stilled <Draw> is a finished
 * stroke; a stilled <TravelPulse> is a dot parked at its destination — the
 * picture still says the same thing, it just says it all at once.
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
import { MONO, accentVar, pop, stamp, sweep, type Accent } from "./shared";

export { MONO, accentVar, pop, stamp, sweep };
export type { Accent };

/** Hairline white, the recessive stroke both directions draw structure in. */
export const HAIR = "rgba(255,255,255,0.14)";

/* ══════════════════════════════ waveform geometry ═════════════════════════ */

export type WaveOpts = {
  /** Box the wave is drawn into, in the parent SVG's user units. */
  w: number;
  h: number;
  /** Peak deflection as a fraction of h/2. Default 0.8. */
  amplitude?: number;
  /** Cycles across the full width. Default 3. */
  frequency?: number;
  /** Phase offset in radians. Default 0. */
  phase?: number;
  /** Sample count. TWO WAVES SHARING A `points` VALUE SHARE A COMMAND
   *  STRUCTURE, which is what makes them morphable — framer can tween `d`
   *  between them. Default 96. */
  points?: number;
  /** Envelope taper, 0 (rectangular) … 1 (pinched to the midline at both
   *  ends). Default 1 — an utterance starts and ends at silence. */
  damp?: number;
  /** Amount of a non-integer overtone mixed in, 0 … 1. A pure sine reads as
   *  "sine wave"; a little inharmonic content reads as "voice". Default 0.35. */
  harmonic?: number;
  /** Left edge, in user units. Default 0. */
  x?: number;
  /** Vertical centre. Default h / 2. */
  y?: number;
};

/**
 * A waveform as an SVG path — pure, deterministic, no DOM.
 *
 * Deterministic matters twice over: the server and the client must draw the
 * same wave (a random one hydrates as a mismatch), and a morph target must be
 * reproducible from props alone.
 */
export function wavePath(o: WaveOpts): string {
  const {
    w,
    h,
    amplitude = 0.8,
    frequency = 3,
    phase = 0,
    points = 96,
    damp = 1,
    harmonic = 0.35,
    x = 0,
    y = h / 2,
  } = o;
  const n = Math.max(2, Math.round(points));
  const peak = (h / 2) * amplitude;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // Envelope: 1 at the centre, (1 - damp) at both edges.
    const env = 1 - damp * (2 * t - 1) ** 2;
    const s =
      (Math.sin(2 * Math.PI * frequency * t + phase) +
        harmonic * Math.sin(2 * Math.PI * frequency * 2.7 * t + phase * 1.4)) /
      (1 + harmonic);
    const px = x + t * w;
    const py = y - peak * env * s;
    parts.push(`${i === 0 ? "M" : "L"}${round(px)} ${round(py)}`);
  }
  return parts.join(" ");
}

const round = (v: number) => Math.round(v * 100) / 100;

/* ══════════════════════════════ svg canvas ════════════════════════════════ */

/**
 * The sized canvas every illustration lives in.
 *
 * Fixed user-unit viewBox, fluid on screen — so a composition is authored in
 * one coordinate space and the modal decides how big it renders. `h` is the
 * height budget: the spotlight is `max-h-[85vh]` and MUST NOT SCROLL on a
 * 1280×800 laptop, which leaves roughly 500 CSS px for the whole body. Keep an
 * illustration at or under 380.
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
      role="img"
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
 * A path that draws itself. The workhorse of the `signal` direction.
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
 * `morphTo` is the split/transform verb of the `signal` direction: give it a
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

/* ══════════════════════════════ stage primitives ══════════════════════════ */

/**
 * The diorama floor. A stage is a scene with a FAR and a NEAR: the vignette
 * and the horizon hairline give the actors somewhere to stand, so a chip
 * placed high reads as further away rather than merely higher up.
 */
export function Stage({
  children,
  accent = "cyan",
  className = "",
}: {
  children: ReactNode;
  accent?: Accent;
  className?: string;
}) {
  return (
    <div className={`relative overflow-hidden rounded-2xl border border-white/8 ${className}`}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(120% 78% at 50% 108%, color-mix(in srgb, ${accentVar(
            accent,
          )} 13%, transparent), transparent 68%)`,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{
          background: `linear-gradient(90deg, transparent, ${accentVar(accent)}55, transparent)`,
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}

/**
 * A track across the stage: an accent rail on the left, an actor on it.
 *
 * `depth` (0 = downstage/near, 1 = upstage/far) dims and shrinks the lane, so a
 * fan of lanes reads as receding rather than as a list. That is the whole
 * difference between a diorama and the rows this file exists to replace.
 */
export function Lane({
  children,
  accent = "cyan",
  depth = 0,
  delay = 0,
  still = false,
  className = "",
}: {
  children: ReactNode;
  accent?: Accent;
  depth?: number;
  delay?: number;
  still?: boolean;
  className?: string;
}) {
  return (
    <motion.div
      initial={still ? { opacity: 1, x: 0 } : { opacity: 0, x: -18 }}
      animate={{ opacity: 1 - depth * 0.35, x: 0 }}
      transition={still ? undefined : { delay, duration: 0.5, ease: EASE }}
      className={`relative flex items-center gap-2.5 ${className}`}
      style={{ scale: 1 - depth * 0.08, transformOrigin: "left center" }}
    >
      <motion.span
        aria-hidden
        {...sweep(delay + 0.1, still)}
        className="h-px flex-1 origin-left"
        style={{
          background: `linear-gradient(90deg, ${accentVar(accent)}00, ${accentVar(accent)}aa)`,
        }}
      />
      {children}
    </motion.div>
  );
}

/** A micro-label chip for a stage scene — the DOM sibling of <Label>. */
export function Tag({
  children,
  accent,
  delay = 0,
  still = false,
  className = "",
}: {
  children: ReactNode;
  accent?: Accent;
  delay?: number;
  still?: boolean;
  className?: string;
}) {
  const c = accent ? accentVar(accent) : "rgba(255,255,255,0.5)";
  return (
    <motion.span
      {...pop(delay, still)}
      className={`font-jetbrains inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em] ${className}`}
      style={{
        borderColor: `color-mix(in srgb, ${c} 38%, transparent)`,
        background: `color-mix(in srgb, ${c} 9%, transparent)`,
        color: c,
      }}
    >
      {children}
    </motion.span>
  );
}

/* ══════════════════════════════ the one line of prose ═════════════════════ */

/**
 * The caption. ONE line, under the picture, secondary by construction.
 *
 * It is deliberately the only prose primitive in this file: if a variant needs
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
