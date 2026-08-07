"use client";

import { motion } from "framer-motion";
import { Chip, MONO, PreviewNote, ROW, accentVar, pop, type Accent } from "./shared";

/*
 * A script, not a queue of requests. Each line lights up with the Character that
 * speaks it, in order, inside ONE call — so the diagram is a script page whose
 * lines fill in, never three separate request cards.
 *
 * The header strip underneath is X-Performance-Report: what the call actually
 * did, line by line. It is drawn as part of the result rather than as a footnote
 * because that is the difference between "we rendered your script" and "here is
 * what we rendered, including the bit that fell back".
 */
const LINES: { who: string; accent: Accent; tag: string; text: string }[] = [
  { who: "MARCUS", accent: "violet", tag: "[weary]", text: "We're not doing this again." },
  { who: "SARAH", accent: "cyan", tag: "[excited]", text: "We absolutely are." },
  { who: "INES", accent: "emerald", tag: "[flat]", text: "I'll get the car." },
];

export default function PerformancePreview({ still }: { still: boolean }) {
  return (
    <div>
      <div className={`${ROW} py-3`}>
        <div className="flex items-center justify-between">
          <span className={`${MONO} text-white/40`}>POST /v1/performance</span>
          <Chip accent="violet" delay={0.15} still={still}>one call</Chip>
        </div>

        <div className="mt-3 space-y-2">
          {LINES.map((l, i) => (
            <motion.div
              key={l.who}
              {...pop(0.25 + i * 0.2, still)}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg px-2 py-1.5"
              style={{ background: `color-mix(in srgb, ${accentVar(l.accent)} 7%, transparent)` }}
            >
              <span className={`${MONO} shrink-0`} style={{ color: accentVar(l.accent) }}>
                {l.who}
              </span>
              <span className={`${MONO} shrink-0 text-white/35`}>{l.tag}</span>
              <span className="min-w-0 text-[14px] text-white/85">{l.text}</span>
            </motion.div>
          ))}
        </div>
      </div>

      <motion.div {...pop(0.95, still)} className={`${ROW} mt-3 py-2.5`}>
        <div className={`${MONO} text-white/40`}>X-Performance-Report</div>
        <div className={`${MONO} mt-1.5 space-y-1 text-white/65`}>
          <div>line 1 · marcus:weary · rendered</div>
          <div>line 2 · sarah:excited · rendered</div>
          {/* The report earns its place by carrying the imperfect row too. */}
          <div className="text-amber-200/80">line 3 · ines:flat → baseline · emotion not in rack</div>
        </div>
      </motion.div>

      <PreviewNote delay={1.1} still={still}>
        Compose it in the playground or post the script straight to the API. Either
        way the response tells you what each line actually became.
      </PreviewNote>
    </div>
  );
}
