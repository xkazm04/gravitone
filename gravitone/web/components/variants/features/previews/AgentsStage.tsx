"use client";

import { motion } from "framer-motion";
import { Caption, Draw, HAIR, Stage, Tag, accentVar, pop, stamp } from "./illus";
import { Wave } from "./shared";

/*
 * agents · STAGE — two actors, one turn, and the moment it is taken back.
 *
 * There is exactly ONE turn token on this stage and it is never duplicated: a
 * duplex conversation is not two people sending messages, it is two people
 * sharing one right to speak. The token travels the beam between them, and the
 * beam is the connection — one line, both directions, drawn once.
 *
 * The barge-in is staged as a SNATCH, not a hop. Its leg of the journey is a
 * twentieth of the run: the token is off the agent and back with the caller
 * before the eye has finished the previous move, which is the difference between
 * an agent that yields and an agent that finishes its sentence at you.
 *
 * What the snatch costs is drawn on the agent, in cyan — the caller's colour,
 * because the caller is who did it. The half-said line stays legible with a bar
 * through it rather than being replaced, since the honest claim is not "the
 * agent said something else", it is "the agent stopped".
 *
 * The `vad` tag sits ON the beam, at the midpoint, because that is literally
 * where the turn boundary is decided — on your box, in service/vad.py, which is
 * also why the meter at the bottom reads zero.
 */

export default function AgentsStage({ still }: { still: boolean }) {
  return (
    <div>
      <Stage accent="cyan" className="px-4 pb-4 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-jetbrains text-[10px] text-white/40">
            wss:// your-arm-box · convai
          </span>
          <Tag accent="cyan" delay={0.15} still={still}>
            one connection
          </Tag>
        </div>

        <div className="relative mt-3 h-[196px]">
          {/* The beam. One line between the two of them, drawn once. */}
          <svg viewBox="0 0 600 196" className="absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-hidden>
            <Draw
              d="M170 66 C300 66 300 150 430 150"
              delay={0.35}
              duration={0.6}
              stroke={HAIR}
              width={1.4}
              still={still}
            />
          </svg>
          <span className="absolute left-1/2 top-[94px] -translate-x-1/2">
            <Tag delay={0.85} still={still}>
              vad · local
            </Tag>
          </span>

          {/* UPSTAGE LEFT — the caller. */}
          <motion.div
            {...pop(0.05, still)}
            className="absolute left-0 top-0 w-[38%] rounded-xl border border-white/12 bg-white/[0.03] px-2.5 py-2"
          >
            <div className="font-jetbrains text-[10px] uppercase tracking-[0.14em] text-cyan-200/70">
              caller
            </div>
            <Wave bars={13} className="mt-1.5 h-5 w-full" accent="cyan" delay={0.35} still={still} />
            <motion.div {...pop(2.1, still)} className="mt-1.5 text-[12px] leading-snug text-white/80">
              Make it Friday.
            </motion.div>
          </motion.div>

          {/* DOWNSTAGE RIGHT — the agent, and what the snatch costs it. */}
          <motion.div
            {...pop(0.2, still)}
            className="absolute bottom-0 right-0 w-[40%] rounded-xl border px-2.5 py-2"
            style={{
              borderColor: `color-mix(in srgb, ${accentVar("violet")} 34%, transparent)`,
              background: `color-mix(in srgb, ${accentVar("violet")} 7%, transparent)`,
              boxShadow: `0 18px 44px -30px ${accentVar("violet")}`,
            }}
          >
            <div className="font-jetbrains text-[10px] uppercase tracking-[0.14em] text-violet-200/75">
              agent
            </div>
            <Wave bars={17} className="mt-1.5 h-5 w-full" accent="violet" delay={1.1} still={still} />
            <div className="relative mt-1.5 w-fit">
              <span className="text-[12px] leading-snug text-white/70">
                Thursday at four is open, and—
              </span>
              <motion.span
                aria-hidden
                initial={still ? { scaleX: 1 } : { scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={still ? undefined : { delay: 2.18, duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                className="absolute inset-x-0 top-1/2 h-px origin-left"
                style={{ background: accentVar("cyan") }}
              />
            </div>
            <motion.span
              {...stamp(2.32, still)}
              className="font-jetbrains mt-1.5 inline-flex rounded-md border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em]"
              style={{
                borderColor: `color-mix(in srgb, ${accentVar("cyan")} 44%, transparent)`,
                background: `color-mix(in srgb, ${accentVar("cyan")} 10%, transparent)`,
                color: accentVar("cyan"),
              }}
            >
              stopped mid-word
            </motion.span>
          </motion.div>

          {/* The one turn. Handed over, SNATCHED back, handed over again. */}
          <motion.span
            aria-hidden
            initial={
              still
                ? { opacity: 1, left: "62%", top: 132 }
                : { opacity: 0, left: "26%", top: 56 }
            }
            animate={
              still
                ? { opacity: 1, left: "62%", top: 132 }
                : {
                    opacity: [0, 1, 1, 1, 1, 1],
                    left: ["26%", "62%", "62%", "28%", "28%", "62%"],
                    top: [56, 132, 132, 58, 58, 132],
                  }
            }
            transition={
              still
                ? undefined
                : {
                    delay: 0.95,
                    duration: 2.9,
                    // The fourth stop is the barge-in: five per cent of the run.
                    times: [0, 0.26, 0.42, 0.47, 0.72, 0.95],
                    ease: [0.22, 1, 0.36, 1],
                  }
            }
            className="font-jetbrains absolute -translate-x-1/2 rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-[0.16em]"
            style={{
              borderColor: `color-mix(in srgb, ${accentVar("cyan")} 52%, transparent)`,
              background: `color-mix(in srgb, ${accentVar("cyan")} 14%, transparent)`,
              color: accentVar("cyan"),
              boxShadow: `0 0 18px -4px ${accentVar("cyan")}`,
            }}
          >
            turn
          </motion.span>
        </div>

        <div className="mt-1 flex items-center gap-3">
          <motion.span {...stamp(2.5, still)} className="font-instrument text-3xl leading-none text-emerald-200">
            $0.00
          </motion.span>
          <span className="font-jetbrains text-[11px] text-white/45">per conversation-minute</span>
        </div>
      </Stage>

      <Caption delay={2.7} still={still}>
        One socket, one turn between you — and taking it back mid-sentence works,
        because the VAD that hears you doing it is running on your box.
      </Caption>
    </div>
  );
}
