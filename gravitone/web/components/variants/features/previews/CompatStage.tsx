"use client";

import { motion } from "framer-motion";
import { Caption, Draw, HAIR, Stage, Tag, accentVar, pop, stamp } from "./illus";

/*
 * compat · STAGE — two stations, one envelope, and what it collects on arrival.
 *
 * Same claim as the signal variant, told as a scene instead of a trace: the old
 * host is UPSTAGE (small, dimmed, struck through — still on the map, just no
 * longer where you send things), your box is DOWNSTAGE, lit, and large enough
 * to hold what arrives. Depth carries the migration, so the picture reads
 * before any label does.
 *
 * The envelope travels the rail once and lands. What stamps onto it on arrival
 * is the actual argument — three parts of the request that did not have to
 * change, in emerald because they are verdicts rather than identities.
 *
 * The violet chip leaving to the left is the honest limit, and it leaves in the
 * opposite direction from everything else on purpose: it is the one thing that
 * comes BACK at you. X-Ignored-Settings names a parameter this engine accepted
 * and did not act on; the alternative — dropping it quietly — would look
 * identical from the outside.
 */

const UNCHANGED = ["xi-api-key", "output_format", "content-type"];

export default function CompatStage({ still }: { still: boolean }) {
  return (
    <div>
      <Stage accent="cyan" className="px-4 pb-4 pt-4">
        {/* UPSTAGE — the host you are leaving. */}
        <motion.div
          initial={still ? { opacity: 0.5, scale: 0.92 } : { opacity: 1, scale: 1 }}
          animate={{ opacity: 0.5, scale: 0.92 }}
          transition={still ? undefined : { delay: 1.2, duration: 0.5 }}
          className="ml-1 w-[56%] origin-top-left"
        >
          <motion.div
            {...pop(0.05, still)}
            className="flex items-center justify-between gap-2 rounded-xl border border-white/12 bg-white/[0.03] px-3 py-2"
          >
            <span className="font-jetbrains text-[11px] text-white/45 line-through">
              api.elevenlabs.io
            </span>
            <Tag delay={1.35} still={still}>
              was
            </Tag>
          </motion.div>
        </motion.div>

        {/* The rail between the stations, and the envelope on it. */}
        <div className="relative h-16">
          {/* The rail runs DIAGONALLY: the envelope crosses the stage, it does
              not drop down a list. `preserveAspectRatio="none"` is safe here
              because the only thing drawn is one curve whose exact angle is
              expressive, not load-bearing. */}
          <svg viewBox="0 0 600 64" className="h-full w-full" preserveAspectRatio="none" aria-hidden>
            <Draw
              d="M120 4 C120 46 460 20 470 60"
              delay={0.5}
              duration={0.55}
              stroke={HAIR}
              width={1.5}
              still={still}
            />
          </svg>
          <motion.span
            initial={still ? { opacity: 1, left: "62%", top: 36 } : { opacity: 0, left: "8%", top: 0 }}
            animate={
              still
                ? { opacity: 1, left: "62%", top: 36 }
                : { opacity: [0, 1, 1], left: "62%", top: 36 }
            }
            transition={still ? undefined : { delay: 0.9, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            className="font-jetbrains absolute -translate-x-1/2 whitespace-nowrap rounded-md border border-white/15 bg-[var(--gt-ink)] px-2 py-1 text-[10px] text-white/70"
          >
            POST /v1/text-to-speech/alba
          </motion.span>
        </div>

        {/* DOWNSTAGE — the box it lands on, and what stamps on arrival. */}
        <motion.div
          {...pop(1.5, still)}
          className="rounded-2xl border px-4 py-3.5"
          style={{
            borderColor: `color-mix(in srgb, ${accentVar("cyan")} 42%, transparent)`,
            background: `color-mix(in srgb, ${accentVar("cyan")} 8%, transparent)`,
            boxShadow: `0 18px 46px -28px ${accentVar("cyan")}`,
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-jetbrains text-[12px] text-cyan-200">your-arm-box.example.com</span>
            <Tag accent="cyan" delay={1.75} still={still}>
              is
            </Tag>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {UNCHANGED.map((h, i) => (
              <motion.span
                key={h}
                {...stamp(1.95 + i * 0.14, still)}
                className="font-jetbrains inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px]"
                style={{
                  borderColor: `color-mix(in srgb, ${accentVar("emerald")} 38%, transparent)`,
                  background: `color-mix(in srgb, ${accentVar("emerald")} 9%, transparent)`,
                  color: accentVar("emerald"),
                }}
              >
                {h}
                <span className="uppercase tracking-[0.14em] opacity-70">unchanged</span>
              </motion.span>
            ))}
          </div>
        </motion.div>

        {/* The one thing that travels the other way. */}
        <motion.div
          initial={still ? { opacity: 1, x: 0 } : { opacity: 0, x: 40 }}
          animate={{ opacity: 1, x: 0 }}
          transition={still ? undefined : { delay: 2.5, duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="mt-3 flex items-center gap-2"
        >
          <span className="font-jetbrains text-[11px] text-violet-300/80" aria-hidden>
            ←
          </span>
          <Tag accent="violet" delay={2.6} still={still}>
            x-ignored-settings: similarity_boost
          </Tag>
        </motion.div>
      </Stage>

      <Caption delay={2.9} still={still}>
        One base URL swap, and the client you already wrote keeps working — with
        anything this engine accepts but does not act on named on the way back.
      </Caption>
    </div>
  );
}
