"use client";

import { motion } from "framer-motion";
import { Caption, Draw, HAIR, Stage, Tag, accentVar, pop, stamp, type Accent } from "./illus";

/*
 * performance · STAGE — the script upstage, one mic downstage, one tape out front.
 *
 * A recording session, staged in depth. The whole script is on the far wall from
 * the first frame, because the whole script left in one request — a page that
 * filled in line by line would be drawing three calls. What happens in sequence
 * is the CASTING: each character steps down its own beam to the one microphone
 * in the middle of the stage, in script order.
 *
 * The converging beams are the load-bearing shape, and they are deliberately the
 * inverse of the cast spotlight's fan: three origins, one destination. Three
 * voices arriving at one render is the entire mechanism, and it is the part of
 * this feature a list of rows cannot draw.
 *
 * Downstage, the tape accumulates left to right in three coloured stretches —
 * one continuous object, not three files, because one call returns one audio
 * stream. The strip under it is X-Performance-Report: the per-line receipt.
 *
 * The honest limit is struck IN THE SCRIPT, where the caller wrote it. `[flat]`
 * stays legible with a bar through it and `baseline` stamped alongside, and the
 * third receipt cell says the same thing. An emotion the rack does not hold is
 * reported, never silently swapped.
 */

const LINES: { who: string; tag: string; text: string; accent: Accent; share: number }[] = [
  { who: "MARCUS", tag: "[weary]", text: "We're not doing this again.", accent: "violet", share: 34 },
  { who: "SARAH", tag: "[excited]", text: "We absolutely are.", accent: "cyan", share: 26 },
  { who: "INES", tag: "[flat]", text: "I'll get the car.", accent: "emerald", share: 40 },
];

/** Where each character stands on its beam, across the stage. */
const BEAM_X = [100, 300, 500];

export default function PerformanceStage({ still }: { still: boolean }) {
  return (
    <div>
      <Stage accent="violet" className="px-4 pb-4 pt-4">
        {/* UPSTAGE — the script. All of it, at once: that is what one call means. */}
        <motion.div
          {...pop(0.05, still)}
          className="mx-auto w-[82%] rounded-xl border border-white/12 bg-white/[0.03] px-3 py-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-jetbrains text-[10px] text-white/40">POST /v1/performance</span>
            <Tag delay={0.3} still={still}>
              one call
            </Tag>
          </div>
          <div className="mt-2 space-y-1">
            {LINES.map((l, i) => (
              <div key={l.who} className="flex flex-wrap items-baseline gap-x-2">
                <span
                  className="font-jetbrains shrink-0 text-[10px]"
                  style={{ color: accentVar(l.accent) }}
                >
                  {l.who}
                </span>
                {/* The metatag the caller wrote. For the line whose emotion is
                    not in the rack, the bar lands on it later — struck in
                    place, because deleting it would hide the request. */}
                <span className="relative shrink-0">
                  <span className="font-jetbrains text-[10px] text-white/35">{l.tag}</span>
                  {i === LINES.length - 1 && (
                    <motion.span
                      aria-hidden
                      initial={still ? { scaleX: 1 } : { scaleX: 0 }}
                      animate={{ scaleX: 1 }}
                      transition={still ? undefined : { delay: 2.2, duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                      className="absolute inset-x-0 top-1/2 h-px origin-left bg-white/45"
                    />
                  )}
                </span>
                {i === LINES.length - 1 && (
                  <motion.span
                    {...stamp(2.4, still)}
                    className="font-jetbrains shrink-0 text-[9px] uppercase tracking-[0.14em] text-violet-300/85"
                  >
                    baseline
                  </motion.span>
                )}
                <span className="min-w-0 text-[12.5px] text-white/80">{l.text}</span>
              </div>
            ))}
          </div>
        </motion.div>

        {/* The beams: three origins, ONE destination. The characters walk them. */}
        <div className="relative h-14">
          <svg viewBox="0 0 600 56" className="h-full w-full" preserveAspectRatio="none" aria-hidden>
            {BEAM_X.map((x, i) => (
              <Draw
                key={x}
                d={`M${x} 0 C${x} 30 300 26 300 54`}
                delay={0.7 + i * 0.1}
                duration={0.45}
                stroke={HAIR}
                width={1.4}
                still={still}
              />
            ))}
          </svg>
          {LINES.map((l, i) => (
            <motion.span
              key={l.who}
              {...pop(1 + i * 0.18, still)}
              className="absolute -translate-x-1/2"
              style={{ left: `${(BEAM_X[i] / 600) * 100}%`, top: 4 + i * 4 }}
            >
              <Tag accent={l.accent} delay={1 + i * 0.18} still={still}>
                {l.who.toLowerCase()}
              </Tag>
            </motion.span>
          ))}
        </div>

        {/* DOWNSTAGE — the one microphone all three arrived at. */}
        <motion.div
          {...pop(1.6, still)}
          className="mx-auto flex w-fit items-center gap-2 rounded-full border px-3 py-1.5"
          style={{
            borderColor: `color-mix(in srgb, ${accentVar("violet")} 44%, transparent)`,
            background: `color-mix(in srgb, ${accentVar("violet")} 10%, transparent)`,
            boxShadow: `0 16px 40px -28px ${accentVar("violet")}`,
          }}
        >
          <span
            aria-hidden
            className="h-3 w-3 rounded-full"
            style={{ background: accentVar("violet") }}
          />
          <span className="font-jetbrains text-[10px] uppercase tracking-[0.14em] text-violet-200">
            one render pass
          </span>
        </motion.div>

        {/* Out front: the tape. One object, three stretches. */}
        <div className="mt-3 flex h-7 overflow-hidden rounded-lg border border-white/12">
          {LINES.map((l, i) => (
            <motion.div
              key={l.who}
              initial={still ? { scaleX: 1, opacity: 1 } : { scaleX: 0, opacity: 0.5 }}
              animate={{ scaleX: 1, opacity: 1 }}
              transition={still ? undefined : { delay: 1.75 + i * 0.16, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="origin-left border-r border-white/10 last:border-r-0"
              style={{
                flexGrow: l.share,
                flexBasis: 0,
                background: `linear-gradient(180deg, color-mix(in srgb, ${accentVar(
                  l.accent,
                )} 30%, transparent), color-mix(in srgb, ${accentVar(l.accent)} 9%, transparent))`,
              }}
            />
          ))}
        </div>

        {/* The receipt, aligned to the stretches it describes. */}
        <div className="mt-2 flex gap-1.5">
          {LINES.map((l, i) => {
            const fell = i === LINES.length - 1;
            return (
              <motion.div
                key={l.who}
                {...pop(2.55 + i * 0.1, still)}
                className={`font-jetbrains rounded-md border px-1.5 py-1 text-[9px] uppercase tracking-[0.12em] ${
                  fell
                    ? "border-amber-400/30 bg-amber-400/[0.07] text-amber-200/85"
                    : "border-white/10 bg-white/[0.02] text-white/45"
                }`}
                style={{ flexGrow: l.share, flexBasis: 0 }}
              >
                line {i + 1} · {fell ? "baseline" : "rendered"}
              </motion.div>
            );
          })}
        </div>
        <motion.div
          {...pop(2.5, still)}
          className="font-jetbrains mt-1.5 text-[9px] uppercase tracking-[0.14em] text-white/30"
        >
          x-performance-report
        </motion.div>
      </Stage>

      <Caption delay={2.9} still={still}>
        A whole script, a voice per line, one call and one tape back — with the
        emotion this rack did not hold named on the receipt rather than swapped in
        silence.
      </Caption>
    </div>
  );
}
