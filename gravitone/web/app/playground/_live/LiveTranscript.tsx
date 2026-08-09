"use client";

// The transcript, in the take card's visual language, and the two things you
// can do with a finished rehearsal: send it to the Script composer, or clear it
// (which never touches the takes it already banked).

import { AnimatePresence, motion } from "framer-motion";
import TakePlayer from "@/components/ui/TakePlayer";
import { EASE } from "@/components/ui/tokens";
import { hueFor, type Row } from "./liveTurns";

export default function LiveTranscript({
  rows, charId, characterName, live, onHandOff, onClear,
}: {
  rows: Row[];
  charId: string;
  /** The dialled Character's name, or undefined when the rail has none. */
  characterName?: string;
  /** A call is up, so the transcript cannot be cleared out from under it. */
  live: boolean;
  onHandOff: () => void;
  onClear: () => void;
}) {
  return (
    <div className="space-y-2">
      <AnimatePresence initial={false}>
        {rows.map((r) => (
          <motion.div key={r.id} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
            <div className="font-jetbrains flex flex-wrap items-center gap-3 text-[11px] text-white/60">
              <span className={r.role === "agent" ? "text-cyan-300" : "text-white/80"}>
                {r.role === "agent" ? (characterName ?? "agent") : "you"}
              </span>
              {r.seconds ? <span>{r.seconds}s</span> : null}
              {r.interim && (
                <span className="rounded-full border border-white/15 px-2 py-0.5 text-white/50"
                  title="Still being heard — this is what the service thinks you are saying, not what it recorded">
                  hearing…
                </span>
              )}
              {r.interrupted && (
                <span className="rounded-full border border-amber-400/25 bg-amber-400/5 px-2 py-0.5 text-amber-200/85"
                  title="You talked over this turn — the take holds the whole reply, but only part of it was heard">
                  interrupted
                </span>
              )}
              {r.role === "agent" && r.url && <span className="text-white/45">↓ in the takes log</span>}
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-white/85">{r.text}</p>
            {r.url && (
              <TakePlayer src={r.url} compact hue={hueFor(charId)} className="mt-2 max-w-[280px]"
                label={`${characterName ?? "agent"} turn`} />
            )}
          </motion.div>
        ))}
      </AnimatePresence>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onHandOff}
          title="Turn this conversation into script lines in the composer"
          className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/75 transition hover:border-cyan-400/40 hover:text-cyan-200"
        >
          → send to Script composer
        </button>
        <button
          onClick={onClear}
          disabled={live}
          title="Clear this transcript (your takes stay in the log)"
          className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/60 transition enabled:hover:border-white/35 disabled:opacity-40"
        >
          clear
        </button>
      </div>
    </div>
  );
}
