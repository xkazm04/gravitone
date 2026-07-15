"use client";

import { motion } from "framer-motion";
import { EMOTIONS } from "@/lib/emotions";

export type Partial = {
  words?: number;
  speakers?: string[];
  transcript?: string;
  segments_total?: number;
  segments_done?: number;
  emotion_counts?: Record<string, number>;
  // segments whose classification failed and fell back to the baseline stem
  label_errors?: number;
  // commit phase: live per-emotion cloning progress
  emotions_done?: number;
  emotions_total?: number;
  current?: string | null;
};

export type LoaderStep = { key: string; label: string; state: "pending" | "active" | "done" };

export type LoaderData = {
  steps: LoaderStep[];
  partial: Partial;
  duration?: number;
};

export function stateOf(data: LoaderData, key: string) {
  return data.steps.find((s) => s.key === key)?.state ?? "pending";
}

/** Live per-emotion tally — grows as segments are classified. */
export function EmotionTally({ counts }: { counts: Record<string, number> }) {
  const max = Math.max(1, ...Object.values(counts));
  const present = EMOTIONS.filter((e) => counts[e.id]);
  if (present.length === 0) return null;
  return (
    <div className="mx-auto mt-4 flex max-w-md flex-wrap justify-center gap-x-5 gap-y-2">
      {present.map((e) => (
        <div key={e.id} className="flex items-center gap-2">
          <div className="flex h-6 items-end gap-[2px]">
            {Array.from({ length: 5 }).map((_, i) => {
              const on = i < Math.round((counts[e.id] / max) * 5);
              return (
                <motion.span key={i} initial={false} animate={{ opacity: on ? 1 : 0.2 }}
                  className="w-[3px] rounded-full" style={{ height: `${6 + i * 4}px`, background: `hsl(${e.hue} 85% 62%)` }} />
              );
            })}
          </div>
          <span className="font-jetbrains text-[11px] text-white/75">
            {e.label} <span className="text-white/45">{counts[e.id]}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
