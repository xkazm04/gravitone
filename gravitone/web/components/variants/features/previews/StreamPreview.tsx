"use client";

import { motion } from "framer-motion";
import { Chip, MONO, PreviewNote, ROW, Wave, pop, sweep } from "./shared";

/*
 * Time is the x axis, so the diagram is a timeline: sentence 1 arrives and is
 * already playing while 2 and 3 are still being rendered. The point is not that
 * it is fast — it is that you do not wait for the last sentence to hear the
 * first, which only a left-to-right drawing says.
 *
 * The mp3 row is the honest half and it is drawn at the same weight as the rest:
 * that format returns one body and names why on X-Stream-Fallback. A streaming
 * feature that quietly stops streaming for the SDK's default format, and does
 * not say so, is the bug this header exists to prevent.
 */
const CHUNKS = [
  { text: "The rain had not stopped since Tuesday.", state: "playing" },
  { text: "She counted the tiles anyway.", state: "streamed" },
  { text: "Forty-one, then the crack.", state: "rendering" },
];

export default function StreamPreview({ still }: { still: boolean }) {
  return (
    <div>
      <div className={`${ROW} py-3`}>
        <div className="flex items-center justify-between">
          <span className={`${MONO} text-white/40`}>POST /v1/text-to-speech/alba/stream · wav_22050</span>
          <Chip delay={0.15} still={still}>first audio ≪ full render</Chip>
        </div>

        <div className="mt-3 space-y-2">
          {CHUNKS.map((c, i) => (
            <motion.div key={c.text} {...pop(0.2 + i * 0.25, still)} className="flex items-center gap-3">
              <span className={`${MONO} w-5 shrink-0 text-white/30`}>{i + 1}</span>
              <div className="relative min-w-0 flex-1 overflow-hidden rounded-lg border border-white/8 px-2.5 py-1.5">
                <motion.span
                  {...sweep(0.3 + i * 0.25, still)}
                  aria-hidden
                  className="absolute inset-y-0 left-0 right-0 origin-left"
                  style={{
                    background:
                      c.state === "rendering"
                        ? "transparent"
                        : "color-mix(in srgb, var(--gt-accent-cyan) 10%, transparent)",
                  }}
                />
                <span
                  className={`relative block truncate text-[13px] ${
                    c.state === "rendering" ? "text-white/35" : "text-white/85"
                  }`}
                >
                  {c.text}
                </span>
              </div>
              {c.state === "playing" ? (
                <Wave bars={7} className="h-4 w-12 shrink-0" delay={0.5} still={still} />
              ) : (
                <span className={`${MONO} w-12 shrink-0 text-right text-white/35`}>{c.state}</span>
              )}
            </motion.div>
          ))}
        </div>
      </div>

      <motion.div
        {...pop(1, still)}
        className={`${MONO} mt-3 rounded-xl border border-amber-400/25 bg-amber-400/5 px-3 py-2.5 text-amber-100/85`}
      >
        mp3_24000_128 → X-Stream: full-body · X-Stream-Fallback: mp3 cannot be
        transcoded incrementally
      </motion.div>

      <PreviewNote delay={1.1} still={still}>
        pcm and wav stream progressively. mp3 — the client SDK&apos;s default —
        comes back whole, and says so in the headers rather than looking like a
        stream that simply took its time.
      </PreviewNote>
    </div>
  );
}
