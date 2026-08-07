"use client";

/*
 * The playground's SIGNAL ACCENTS — the restrained tier of the house language
 * (`web/DESIGN.md`, "Where Signal applies — and where it doesn't").
 *
 * The console is a tool someone operates all day, so nothing here performs.
 * There is no illustration next to a control: what lives in this file are the
 * moments where the console has NOTHING to show but words — an empty log, a
 * render in flight — and the one moment it has something new to point at, a
 * take that just landed. Each is drawn in the same vocabulary the landing uses
 * (`components/variants/features/previews/illus.tsx`), at a fraction of the
 * size, with the existing sentence kept verbatim as the caption.
 *
 * MOTION. Entrance-only and still-aware, exactly as the doctrine says: `still`
 * gates the animation and never drops an element, so a reduced-motion reader
 * gets the END of the drawing rather than a missing one. The single loop in
 * here is the render rail — a loader by definition idles — and it pauses
 * offscreen (`usePauseOffscreen`) and stops dead under `still`.
 *
 * NO COLOUR LITERALS. Cyan comes from `accentVar`, hairline from `HAIR`.
 */

import { motion } from "framer-motion";
import {
  Caption,
  Draw,
  HAIR,
  Illus,
  Label,
  Node,
  accentVar,
  wavePath,
} from "@/components/variants/features/previews/illus";
import { usePauseOffscreen } from "@/components/ui/Equalizer";
import { EASE } from "@/components/ui/tokens";

const CYAN = accentVar("cyan");

/* ══════════════════════════════ empty take log ════════════════════════════ */

const EMPTY_W = 420;
const EMPTY_H = 104;
/** The log's own rail: one flat hairline, which is what silence looks like. */
const EMPTY_RAIL = "M28 60 H392";
/** The take that has not been rendered — a wave in the accent, drawn DASHED,
 *  because a dashed stroke is this vocabulary's "route not taken". */
const EMPTY_WAVE = wavePath({
  w: 264,
  h: 52,
  x: 112,
  y: 60,
  amplitude: 0.9,
  frequency: 3.2,
  points: 64,
});

/**
 * "No takes yet" — drawn instead of only stated.
 *
 * It teaches what a take IS: words leave the composer (the node at the left),
 * travel the log's rail, and arrive as a wave you can hear. The wave is dashed
 * and the rail is flat, so the picture says the same thing the sentence does —
 * nothing has been recorded onto this line yet.
 */
export function EmptyTakes({ still }: { still: boolean }) {
  return (
    <div className="px-5 py-8">
      <Illus w={EMPTY_W} h={EMPTY_H}>
        <Label x={28} y={34} size={9} still={still}>
          take 01
        </Label>
        {/* The rail, silent end to end. */}
        <Draw d={EMPTY_RAIL} delay={0.05} duration={0.7} stroke={HAIR} width={1} still={still} />
        {/* Where a take enters the log. */}
        <Node x={28} y={60} r={3} delay={0.55} still={still} />
        {/* The take that is not there. */}
        <Draw
          d={EMPTY_WAVE}
          delay={0.6}
          duration={0.6}
          stroke={CYAN}
          width={1.4}
          opacity={0.7}
          dashed
          still={still}
        />
        <Label x={244} y={98} anchor="middle" size={9} delay={1} still={still}>
          nothing recorded
        </Label>
      </Illus>
      <Caption delay={1.15} still={still}>
        No takes yet — compose above and hit Generate.
      </Caption>
    </div>
  );
}

/* ══════════════════════════════ render in flight ══════════════════════════ */

const RAIL_W = 320;
const RAIL_H = 26;
const RENDER_RAIL = `M0 13 H${RAIL_W}`;
/** The audio being written onto that rail. Damped at both ends, so the segment
 *  reads as one utterance rather than a clipped loop. */
const RENDER_WAVE = wavePath({
  w: RAIL_W,
  h: 22,
  y: 13,
  amplitude: 0.95,
  frequency: 5,
  points: 96,
  damp: 0.3,
});

/**
 * The "rendering" row's picture: a wave writing itself along the rail, over and
 * over, for as long as the engine is working.
 *
 * It replaces a 48-bar CSS equalizer — a shape that claimed to be levels while
 * being a fixed keyframe, and which `prefers-reduced-motion` froze into a solid
 * block of 48 full-height bars, because globals.css kills the animation and the
 * bars are authored at `height: 100%`. A dash-draw has an honest still frame by
 * construction: the finished wave.
 *
 * This is the one loop in the playground's Signal layer, and it is the case the
 * doctrine allows — a loader idles until its work returns. It pauses offscreen
 * and stops entirely under `still`; the MEASURED numbers beside it (elapsed,
 * streamed seconds, queue depth) are untouched and remain the honest report.
 */
export function RenderRail({ still }: { still: boolean }) {
  const { ref, paused } = usePauseOffscreen<HTMLDivElement>();
  const frozen = still || paused;
  return (
    <div ref={ref} className="min-w-0 flex-1" aria-hidden>
      <svg
        viewBox={`0 0 ${RAIL_W} ${RAIL_H}`}
        className="h-8 w-full"
        preserveAspectRatio="none"
        aria-hidden
      >
        <path d={RENDER_RAIL} fill="none" stroke={HAIR} strokeWidth={1} />
        {frozen ? (
          <path
            d={RENDER_WAVE}
            fill="none"
            stroke={CYAN}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
            opacity={0.85}
          />
        ) : (
          <motion.path
            d={RENDER_WAVE}
            fill="none"
            stroke={CYAN}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
            strokeDasharray="1 1"
            initial={{ strokeDashoffset: 1, opacity: 0.85 }}
            animate={{ strokeDashoffset: 0 }}
            transition={{ duration: 1.5, ease: EASE, repeat: Infinity, repeatDelay: 0.2 }}
          />
        )}
      </svg>
    </div>
  );
}

/* ══════════════════════════════ a take arriving ═══════════════════════════ */

/**
 * One accent hairline across the top of the NEWEST take card, drawn once as
 * that take arrives.
 *
 * The completion is already announced in text and in the log's order; this is
 * its visual sibling — the "a signal just landed here" stroke, spent on a
 * single line rather than a diagram. Exactly one card carries it at a time
 * (the console renders it only for the newest take), so it stays a marker and
 * never becomes card chrome: the next take takes the edge away from this one.
 *
 * It animates on mount and never again — a re-render of the same card is not a
 * new arrival. Stilled, it is that hairline, present and complete.
 */
export function TakeArrival({ still }: { still: boolean }) {
  return (
    <svg
      viewBox="0 0 100 2"
      preserveAspectRatio="none"
      aria-hidden
      data-testid="take-arrival"
      className="pointer-events-none absolute inset-x-5 top-0 h-[2px]"
    >
      <Draw d="M0 1 H100" duration={0.55} stroke={CYAN} width={2} opacity={0.85} still={still} />
    </svg>
  );
}
