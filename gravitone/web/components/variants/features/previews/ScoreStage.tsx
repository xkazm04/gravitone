"use client";

import { motion } from "framer-motion";
import { Caption, Stage, Tag, accentVar, pop, stamp, sweep, type Accent } from "./illus";
import { Wave } from "./shared";

/*
 * score · STAGE — the line as a staff, the emotions as measures under it.
 *
 * A conductor's desk. Upstage, dim and italic, is the marking the studio
 * SUGGESTS for the line; midstage is the staff, ruled, with the words sitting
 * on it; downstage are the measures, one per region, divided by real barlines.
 *
 * Words and measures share ONE grid, so every measure stands directly under the
 * words it governs. That alignment is the claim: a region is a span of this
 * sentence, not a setting on the whole take. The text never moves — the colour
 * sweeps in over it, left to right, the way a marking is added to a part that
 * is already written.
 *
 * The third measure is where the honesty lives. `whisper` is struck IN PLACE
 * and `baseline` stamps in beside it, because the request was real and the
 * response says both things: what you asked for, and what was rendered. The
 * violet receipt under it is the per-segment report — the difference between a
 * fallback and a silent substitution is that one of them tells you, and that
 * receipt is the entire difference drawn.
 */

const MEASURES: {
  text: string;
  emotion: string;
  accent: Accent;
  bars: number;
  fallback?: string;
}[] = [
  { text: "You came back.", emotion: "warm", accent: "cyan", bars: 10 },
  { text: "After everything.", emotion: "wry", accent: "violet", bars: 14 },
  { text: "Don't say a word.", emotion: "whisper", accent: "emerald", bars: 18, fallback: "baseline" },
];

/* The measures are as wide as the words they govern — the grid IS the staff. */
const GRID = "grid grid-cols-[3fr_3fr_4fr]";

export default function ScoreStage({ still }: { still: boolean }) {
  return (
    <div>
      <Stage accent="violet" className="px-4 pb-4 pt-3.5">
        {/* UPSTAGE — the marking, in the hand of whoever read the line first. */}
        <div className="flex items-center justify-end gap-2 pb-2 pr-1">
          <motion.span
            {...pop(0.1, still)}
            className="font-instrument text-[15px] italic text-white/45"
          >
            hesitant, then flat
          </motion.span>
          <Tag accent="violet" delay={0.25} still={still}>
            suggested direction
          </Tag>
        </div>

        {/* The staff. */}
        <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "repeating-linear-gradient(to bottom, transparent 0 17px, rgba(255,255,255,0.055) 17px 18px)",
            }}
          />

          <div className={`relative ${GRID}`}>
            {MEASURES.map((m, i) => (
              <div
                key={m.emotion}
                className={`px-3 pb-3 pt-3.5 ${i > 0 ? "border-l border-white/10" : ""}`}
              >
                {/* The words, painted over rather than replaced. */}
                <span className="relative inline-block">
                  <motion.span
                    {...sweep(0.45 + i * 0.2, still)}
                    aria-hidden
                    className="absolute inset-0 origin-left rounded-md"
                    style={{
                      background: `color-mix(in srgb, ${accentVar(m.accent)} ${
                        m.fallback ? 7 : 17
                      }%, transparent)`,
                    }}
                  />
                  <span className="relative block px-1 text-[14.5px] leading-snug text-white">
                    {m.text}
                  </span>
                </span>

                {/* The measure under it. */}
                <Wave
                  bars={m.bars}
                  className="mt-3 h-6 w-full"
                  accent={m.fallback ? "cyan" : m.accent}
                  delay={0.9 + i * 0.18}
                  still={still}
                />

                <div className="mt-2.5 flex flex-wrap items-center gap-1">
                  {m.fallback ? (
                    <>
                      {/* Asked for — kept on the page, struck. */}
                      <motion.span
                        initial={still ? { opacity: 0.4 } : { opacity: 1 }}
                        animate={{ opacity: 0.4 }}
                        transition={still ? undefined : { delay: 1.75, duration: 0.4 }}
                        className="font-jetbrains text-[10px] uppercase tracking-[0.14em] text-white/60 line-through"
                      >
                        {m.emotion}
                      </motion.span>
                      {/* Rendered — stamped in beside it, not over it. */}
                      {/* inline-flex, not a bare span: a transform does not
                          apply to a non-replaced inline element. */}
                      <motion.span {...stamp(1.9, still)} className="inline-flex">
                        <Tag delay={0} still>
                          {m.fallback}
                        </Tag>
                      </motion.span>
                    </>
                  ) : (
                    <Tag accent={m.accent} delay={1.2 + i * 0.15} still={still}>
                      {m.emotion}
                    </Tag>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* The receipt the third measure leaves behind. */}
          <motion.div
            initial={still ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={still ? undefined : { delay: 2.15, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className={`relative ${GRID} border-t border-white/10`}
          >
            <span className="col-span-2 px-3 py-2 font-jetbrains text-[10px] uppercase tracking-[0.14em] text-white/30">
              per-segment report
            </span>
            <span className="border-l border-white/10 px-3 py-2">
              <Tag accent="violet" delay={2.3} still={still}>
                segment 3 · whisper not in this rack → baseline
              </Tag>
            </span>
          </motion.div>
        </div>
      </Stage>

      <Caption delay={2.5} still={still}>
        Every measure is its own embedding of the same person — and the one this
        Character has never recorded falls back to baseline in the open, on its own
        line of the report.
      </Caption>
    </div>
  );
}
