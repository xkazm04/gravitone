"use client";

import { motion } from "framer-motion";
import { Caption, Draw, HAIR, Lane, Stage, Tag, accentVar, pop, stamp } from "./illus";
import { Wave } from "./shared";

/*
 * sovereign · STAGE — a lit room, and a door that is never opened.
 *
 * Same claim as the signal variant, told as a scene: the cloud is UPSTAGE,
 * unlit and struck, and it never receives an actor. Your machine is DOWNSTAGE,
 * lit, and every actor in this play stands inside it. Depth carries the whole
 * argument — the reader sees where the work happens before reading a word.
 *
 * The rail between them is drawn and then cancelled in place. A stage with no
 * rail at all would say the cloud is unrelated; a rail with an X on it says the
 * route exists in every other product and this mode declines to use it.
 *
 * The diarizer is a RESIDENT, not a service: a small actor standing inside the
 * box, between the recording lane and the two speaker lanes it produces. It is
 * the only actor with a size on it (~34 MB) because that size is the entire
 * cost of the feature.
 *
 * The honest limit is a piece of set, not a footnote. The two speaker lanes are
 * fenced inside one dashed violet bracket — the fence says "these two are one
 * guess", which is exactly what the local diarizer reports: the boundaries are
 * dependable, the count skews high, and one person can come back as two.
 */

const SPEAKERS = [
  { name: "speaker a", bars: 13, depth: 0.22 },
  { name: "speaker b", bars: 19, depth: 0 },
];

export default function SovereignStage({ still }: { still: boolean }) {
  const violet = accentVar("violet");

  return (
    <div>
      <Stage accent="cyan" className="px-4 pb-4 pt-3.5">
        {/* UPSTAGE — the room nobody walks into. Dim from the first frame: it is
            not something that was turned off, it is something never turned on. */}
        <motion.div
          {...pop(0.05, still)}
          className="mx-auto flex w-[76%] items-center justify-between gap-2 rounded-xl border border-dashed border-white/12 px-3 py-2 opacity-45"
        >
          <span className="font-jetbrains text-[10px] text-white/45 line-through">
            cloud transcription · cloud diarization · an api key
          </span>
          <Tag delay={0.35} still={still}>
            never dialled
          </Tag>
        </motion.div>

        {/* The rail that exists everywhere else, cancelled here. */}
        <div className="relative h-11">
          <svg viewBox="0 0 600 44" className="h-full w-full" preserveAspectRatio="none" aria-hidden>
            <Draw
              d="M300 42 V6"
              delay={0.5}
              duration={0.4}
              stroke={accentVar("cyan")}
              width={1.5}
              dashed
              still={still}
            />
          </svg>
          <motion.span
            {...stamp(1, still)}
            aria-hidden
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[15px] leading-none text-white/55"
          >
            ✕
          </motion.span>
          <div className="absolute right-1 top-1/2 -translate-y-1/2">
            <Tag delay={1.15} still={still}>
              no outbound socket
            </Tag>
          </div>
        </div>

        {/* DOWNSTAGE — the lit box. Everything that follows is inside it. */}
        <motion.div
          {...pop(0.7, still)}
          className="rounded-2xl border px-4 py-3.5"
          style={{
            borderColor: `color-mix(in srgb, ${accentVar("cyan")} 42%, transparent)`,
            background: `color-mix(in srgb, ${accentVar("cyan")} 7%, transparent)`,
            boxShadow: `0 18px 46px -28px ${accentVar("cyan")}`,
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-jetbrains text-[12px] text-cyan-200">your machine</span>
            <Tag accent="cyan" delay={0.9} still={still}>
              no keys set
            </Tag>
          </div>

          {/* The recording, upstage within the box. */}
          <Lane accent="cyan" depth={0.5} delay={1.1} still={still} className="mt-3">
            <Wave bars={30} className="h-5 w-[42%]" accent="cyan" delay={1.25} still={still} />
            <Tag delay={1.3} still={still}>
              one recording
            </Tag>
          </Lane>

          {/* The resident who does the separating. */}
          <motion.div
            {...pop(1.5, still)}
            className="mt-3 flex items-center gap-2 rounded-xl border border-white/12 bg-white/[0.04] px-2.5 py-1.5"
          >
            <span
              aria-hidden
              className="h-5 w-5 shrink-0 rounded-full"
              style={{
                background: `radial-gradient(circle at 34% 30%, ${accentVar("cyan")}, transparent 72%)`,
                border: `1px solid color-mix(in srgb, ${accentVar("cyan")} 45%, transparent)`,
              }}
            />
            <span className="font-jetbrains text-[11px] text-white/70">local diarizer</span>
            <span className="ml-auto flex items-center gap-1.5">
              <Tag delay={1.7} still={still}>
                ~34 mb
              </Tag>
              <Tag accent="cyan" delay={1.78} still={still}>
                offline
              </Tag>
            </span>
          </motion.div>

          {/* What it produces — fenced, because the fence is the caveat. */}
          <div
            className="mt-2.5 space-y-2 rounded-xl border border-dashed px-2.5 py-2"
            style={{ borderColor: `color-mix(in srgb, ${violet} 34%, transparent)` }}
          >
            {SPEAKERS.map((s, i) => (
              <Lane key={s.name} accent="cyan" depth={s.depth} delay={1.95 + i * 0.14} still={still}>
                <Wave bars={s.bars} className="h-5 w-[34%]" accent="cyan" delay={2.1 + i * 0.14} still={still} />
                <Tag accent="cyan" delay={2.15 + i * 0.14} still={still}>
                  {s.name}
                </Tag>
              </Lane>
            ))}
            <div className="flex justify-end">
              <Tag accent="violet" delay={2.4} still={still}>
                count is a hypothesis · skews high
              </Tag>
            </div>
          </div>
        </motion.div>

        {/* The consequence, stamped last. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <motion.span {...stamp(2.6, still)} className="font-instrument text-2xl text-emerald-200">
            $0.00
          </motion.span>
          <span className="font-jetbrains text-[11px] text-white/45">
            per minute — and every segment comes back baseline, because there is no
            local emotion classifier
          </span>
        </div>
      </Stage>

      <Caption delay={2.8} still={still}>
        The room is lit and the door stays shut: separation, cloning and speech all
        happen here, and the mode names what it cannot do instead of degrading
        quietly.
      </Caption>
    </div>
  );
}
