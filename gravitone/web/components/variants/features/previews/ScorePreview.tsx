"use client";

import { motion } from "framer-motion";
import { Chip, MONO, PreviewNote, ROW, accentVar, pop, sweep, type Accent } from "./shared";

/*
 * Direction as a score: the text stays put, and the emotion is painted OVER a
 * span of it. That is the actual editing model — regions on a line, not a
 * dropdown that recolours the whole take — so the spans sweep in left to right
 * across words that never move.
 *
 * The last span is the honest one. `whisper` is an emotion this Character does
 * not have, so it renders as a fallback to baseline WITH the report, because
 * that is what the response does (the fallback is named per segment rather than
 * swapped behind the caller's back).
 */
const SPANS: { text: string; emotion: string; accent: Accent; fallback?: string }[] = [
  { text: "You came back.", emotion: "warm", accent: "cyan" },
  { text: "After everything.", emotion: "wry", accent: "violet" },
  { text: "Don't say a word.", emotion: "whisper", accent: "emerald", fallback: "baseline" },
];

export default function ScorePreview({ still }: { still: boolean }) {
  return (
    <div>
      <div className={`${ROW} py-3`}>
        <span className={`${MONO} text-white/40`}>sarah · one line, three directions</span>
        <p className="mt-3 flex flex-wrap gap-x-1.5 gap-y-2 text-[15px] leading-relaxed text-white">
          {SPANS.map((s, i) => (
            <span key={s.text} className="relative inline-block">
              <motion.span
                {...sweep(0.25 + i * 0.22, still)}
                aria-hidden
                className="absolute inset-x-0 bottom-0 top-0 origin-left rounded-md"
                style={{ background: `color-mix(in srgb, ${accentVar(s.accent)} 16%, transparent)` }}
              />
              <span className="relative px-1">{s.text}</span>
            </span>
          ))}
        </p>
      </div>

      <div className="mt-3 space-y-1.5">
        {SPANS.map((s, i) => (
          <motion.div
            key={s.emotion}
            {...pop(0.6 + i * 0.12, still)}
            className={`${MONO} flex items-center gap-2 rounded-lg border border-white/8 px-2.5 py-1.5`}
          >
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: accentVar(s.accent) }} />
            <span style={{ color: accentVar(s.accent) }}>{s.emotion}</span>
            {s.fallback ? (
              // Not styled as an error — it is a correct, reported outcome. Amber
              // is this app's "warning", and the copy names the true state.
              <span className="ml-auto text-amber-200/80">
                not in this rack → {s.fallback}, reported on the segment
              </span>
            ) : (
              <span className="ml-auto text-white/40">own embedding · rendered as marked</span>
            )}
          </motion.div>
        ))}
      </div>

      <div className="mt-3">
        <Chip accent="violet" delay={1} still={still}>
          suggested direction: hesitant, then flat
        </Chip>
      </div>

      <PreviewNote delay={1.1} still={still}>
        Each emotion is its own embedding, so the same Character stays the same
        person across all three — and an emotion it does not have is a line in the
        report, never a silent substitution.
      </PreviewNote>
    </div>
  );
}
