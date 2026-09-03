"use client";

// The forensic room's skeleton, kept from the Ladder prototype: a vertical
// hairline rail with one node per phase, each phase a panel to its right.
// States are derived, never stored: a phase with findings is "done" work,
// a phase waiting on data is dimmed. Entrance-only motion (`rise`).

import { motion } from "framer-motion";

import { Panel } from "@/components/ui/Primitives";
import { rise } from "@/components/ui/tokens";

export type PhaseState = "active" | "done" | "idle";

export function Phase({
  index,
  title,
  sub,
  state,
  last = false,
  children,
}: {
  index: number;
  title: string;
  sub: string;
  state: PhaseState;
  last?: boolean;
  children: React.ReactNode;
}) {
  const node =
    state === "done"
      ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-300"
      : state === "active"
        ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200"
        : "border-white/15 bg-white/5 text-white/40";
  return (
    <motion.li
      className="relative flex gap-5"
      variants={rise}
      initial="hidden"
      animate="show"
      custom={index}
    >
      <div className="flex flex-col items-center">
        <span
          className={`font-jetbrains grid h-9 w-9 shrink-0 place-items-center rounded-full border text-[13px] transition-colors ${node}`}
        >
          {index + 1}
        </span>
        {!last && <span className="w-px flex-1 bg-white/8" aria-hidden />}
      </div>
      <div className="min-w-0 flex-1 pb-10">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 className="font-instrument text-2xl text-white">{title}</h2>
          <span className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-white/45">
            {sub}
          </span>
        </div>
        <Panel className="mt-4 p-5">{children}</Panel>
      </div>
    </motion.li>
  );
}
