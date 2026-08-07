"use client";

import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Zap } from "lucide-react";
import { Chip, ConfirmBar, MONO, PreviewNote, ROW, pop, stamp } from "./shared";

/*
 * A duplex socket, drawn as one. Turns alternate down the page with the arrow
 * pointing the way the audio is travelling, which is the only part of a
 * conversation API a static screenshot never shows.
 *
 * The barge-in row is the reason this diagram exists: the caller interrupts
 * mid-answer, the agent stops. An agent that finishes its sentence while you are
 * already talking is the failure mode everyone has met, so the drawing puts the
 * interrupt in the middle rather than listing it as a bullet.
 */
const TURNS = [
  { dir: "up" as const, who: "caller", text: "…so can it just book the slot for me?" },
  { dir: "down" as const, who: "agent", text: "Sure — Thursday at four is open, and—" },
  { dir: "barge" as const, who: "caller", text: "Make it Friday." },
  { dir: "down" as const, who: "agent", text: "Friday at four. Booked." },
];

export default function AgentsPreview({ still }: { still: boolean }) {
  return (
    <div>
      <div className={`${ROW} py-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={`${MONO} text-white/40`}>wss:// your-arm-box · convai</span>
          <Chip delay={0.15} still={still}>same browser SDK</Chip>
        </div>

        <div className="mt-3 space-y-2">
          {TURNS.map((t, i) => (
            <motion.div
              key={t.text}
              {...pop(0.25 + i * 0.18, still)}
              className={`flex items-start gap-2.5 rounded-lg border px-2.5 py-2 ${
                t.dir === "barge"
                  ? "border-amber-400/30 bg-amber-400/[0.06]"
                  : "border-white/8 bg-white/[0.02]"
              }`}
            >
              <span aria-hidden className="mt-0.5 shrink-0">
                {t.dir === "down" ? (
                  <ArrowRight className="h-3.5 w-3.5 text-cyan-300/70" />
                ) : t.dir === "barge" ? (
                  <Zap className="h-3.5 w-3.5 text-amber-300/80" />
                ) : (
                  <ArrowLeft className="h-3.5 w-3.5 text-violet-300/70" />
                )}
              </span>
              <div className="min-w-0">
                <div className={`${MONO} ${t.dir === "barge" ? "text-amber-200/80" : "text-white/35"}`}>
                  {t.dir === "barge" ? "barge-in — the agent stops mid-word" : t.who}
                </div>
                <div className="mt-0.5 text-[13px] leading-relaxed text-white/80">{t.text}</div>
              </div>
            </motion.div>
          ))}
        </div>

        <motion.div {...pop(1, still)} className={`${MONO} mt-3 flex items-center gap-2 text-white/35`}>
          <span>local VAD found every turn boundary</span>
          <span className="ml-auto">no transcript left the box</span>
        </motion.div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <motion.span {...stamp(1.05, still)} className="font-instrument text-3xl text-emerald-200">
          $0.00
        </motion.span>
        <span className={`${MONO} text-white/45`}>per conversation-minute</span>
      </div>

      <ConfirmBar accent="cyan" delay={1.15} still={still}>
        an app written against ElevenLabs Agents repoints by changing one base URL
      </ConfirmBar>

      <PreviewNote delay={1.25} still={still}>
        Turn-taking, ping/pong and per-session prompt overrides are all served from
        the same worker pool that does your synthesis.
      </PreviewNote>
    </div>
  );
}
