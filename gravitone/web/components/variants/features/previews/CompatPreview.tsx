"use client";

import { motion } from "framer-motion";
import { Chip, MONO, PreviewNote, ROW, pop, sweep } from "./shared";

/*
 * The migration, as one request.
 *
 * The base URL is the only line that changes — so it is the only line that
 * moves: the old host strikes through and the new one sweeps in under it, while
 * the headers and the query grammar stamp in UNCHANGED beside it. The diagram
 * has to earn the word "drop-in", and the way to do that is to show what stays.
 */
export default function CompatPreview({ still }: { still: boolean }) {
  return (
    <div>
      <div className={`${ROW} p-0`}>
        <div className="border-b border-white/8 px-3 py-2">
          <span className={`${MONO} text-white/40`}>POST /v1/text-to-speech/alba?output_format=mp3_24000_128</span>
        </div>
        <div className="space-y-1.5 px-3 py-3">
          <motion.div {...pop(0.1, still)} className={`${MONO} flex items-baseline gap-2`}>
            <span className="text-white/35">base_url</span>
            <span className="text-white/30 line-through">https://api.elevenlabs.io</span>
          </motion.div>
          <div className="relative">
            <motion.div
              {...sweep(0.35, still)}
              className="absolute inset-y-0 left-0 origin-left rounded-md"
              style={{ background: "color-mix(in srgb, var(--gt-accent-cyan) 12%, transparent)", right: 0 }}
              aria-hidden
            />
            <motion.div {...pop(0.45, still)} className={`${MONO} relative flex items-baseline gap-2 py-0.5`}>
              <span className="text-white/35">base_url</span>
              <span className="text-cyan-200">https://your-arm-box.example.com</span>
            </motion.div>
          </div>
          {/* Everything below is what did NOT have to change. */}
          {[
            { k: "xi-api-key", v: "gk_live_…", d: 0.6 },
            { k: "Content-Type", v: "application/json", d: 0.7 },
            { k: "output_format", v: "mp3_24000_128", d: 0.8 },
          ].map((h) => (
            <motion.div key={h.k} {...pop(h.d, still)} className={`${MONO} flex items-baseline gap-2`}>
              <span className="text-white/35">{h.k}</span>
              <span className="text-white/70">{h.v}</span>
              <span className="ml-auto text-emerald-300/70">unchanged</span>
            </motion.div>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Chip accent="violet" delay={0.95} still={still}>
          ← X-Ignored-Settings: similarity_boost
        </Chip>
      </div>

      <PreviewNote delay={1.05} still={still}>
        A setting this engine accepts but does not act on comes back named in a
        response header. Silently dropping it would look identical from the
        outside — which is the whole reason it is not what happens.
      </PreviewNote>
    </div>
  );
}
