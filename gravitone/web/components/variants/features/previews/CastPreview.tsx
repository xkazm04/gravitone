"use client";

import { motion } from "framer-motion";
import { Chip, ConfirmBar, MONO, PreviewNote, ROW, Wave, accentVar, pop } from "./shared";

const SPEAKERS = [
  { name: "Sarah", tag: "narration", accent: "cyan" as const },
  { name: "Marcus", tag: "gruff", accent: "violet" as const },
  { name: "Ines", tag: "bright", accent: "emerald" as const },
];

/*
 * One source, N Characters — the split is the claim.
 *
 * A single waveform at the top, three lanes underneath, three Character cards
 * popping out of them. The mechanism the card names is that ONE analysis is
 * paid for and every speaker in it is castable, so the diagram deliberately
 * shows one input and three outputs rather than three imports.
 *
 * The consent bar is not decoration: cloning refuses without an attestation
 * (service/voices.py:1246), so a diagram of cloning that omitted it would be
 * showing a code path that does not exist.
 */
export default function CastPreview({ still }: { still: boolean }) {
  return (
    <div>
      <div className={ROW}>
        <div className="flex items-center justify-between">
          <span className={`${MONO} text-white/40`}>one link · one analysis</span>
          <Chip delay={0.15} still={still}>1 paid scan</Chip>
        </div>
        <Wave bars={34} className="mt-3 h-10 w-full" delay={0.1} still={still} />
      </div>

      {/* The split. Three lanes fan out of the single source above. */}
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {SPEAKERS.map((s, i) => (
          <motion.div key={s.name} {...pop(0.4 + i * 0.12, still)} className={`${ROW} py-3`}>
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="h-6 w-6 shrink-0 rounded-full"
                style={{
                  background: `radial-gradient(circle at 32% 30%, ${accentVar(s.accent)}, transparent 72%)`,
                  border: `1px solid color-mix(in srgb, ${accentVar(s.accent)} 45%, transparent)`,
                }}
              />
              <div className="min-w-0">
                <div className="truncate text-[13px] text-white">{s.name}</div>
                <div className={`${MONO} truncate text-white/40`}>{s.tag}</div>
              </div>
            </div>
            <Wave bars={12} className="mt-2.5 h-5 w-full" accent={s.accent} delay={0.55 + i * 0.12} still={still} />
          </motion.div>
        ))}
      </div>

      <ConfirmBar delay={1} still={still}>
        consent receipt stored · one per cloned voice
      </ConfirmBar>

      <PreviewNote delay={1.1} still={still}>
        Every speaker the scan separated can become its own Character with its own
        emotion rack — from the analysis you already paid for once.
      </PreviewNote>
    </div>
  );
}
