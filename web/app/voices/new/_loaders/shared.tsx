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

// What speech detection FOUND, as the backend measured it
// (service/ingest.py::SpeechScan / Levels). `spans` is a COUNT of speech spans,
// not the spans themselves; the dB fields are null when this clip's own levels
// could not be measured, in which case `adaptive` is false and `threshold_db`
// is the fixed fallback rather than something derived from this recording.
export type Detection = {
  outcome: "spans" | "unbroken" | "silent" | "too_short" | (string & {});
  spans: number;
  speech_seconds: number;
  noise_floor_db: number | null;
  speech_db: number | null;
  threshold_db: number | null;
  adaptive: boolean;
};

// Each outcome named as itself. They are four different facts about a
// recording and used to reach the user as one sentence (or, for `unbroken`, as
// a fake transcript in quotation marks).
const OUTCOME_HEADLINE: Record<string, string> = {
  spans: "speech found — cut at the pauses",
  unbroken: "no pauses found — the whole recording is one take",
  silent: "no speech above the background level",
  too_short: "too short for one usable speech span",
};

function db(v: number | null): string | null {
  return v === null ? null : `${v.toFixed(0)} dBFS`;
}

/**
 * The speech-detection outcome, presented as a FINDING about the recording.
 * Never italic, never in quotation marks: none of this is anything the speaker
 * said, and `unbroken` used to render exactly where a transcript goes.
 *
 * `note` is the backend's own sentence for the outcome (it authors one for
 * every outcome except `spans`); the measured line underneath is built from the
 * levels it reports, so nothing here restates a backend constant.
 */
export function DetectionFinding({ detection, note }: { detection: Detection; note?: string | null }) {
  const headline = OUTCOME_HEADLINE[detection.outcome] ?? "speech detection finished";
  const threshold = db(detection.threshold_db);
  const measured: string[] = [];
  if (detection.outcome !== "silent" && detection.outcome !== "too_short") {
    measured.push(`${detection.spans} span${detection.spans === 1 ? "" : "s"}`);
    measured.push(`${detection.speech_seconds}s of speech`);
  }
  if (threshold) {
    measured.push(detection.adaptive
      ? `silence threshold ${threshold}, derived from this recording`
      : `silence threshold ${threshold} (fixed fallback — this recording's own levels could not be measured)`);
  }
  const floor = db(detection.noise_floor_db);
  const speech = db(detection.speech_db);
  if (floor && speech) measured.push(`background ${floor}, speech ${speech}`);
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <div className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">
        finding · {headline}
      </div>
      {note && <p className="mt-1.5 text-[13px] leading-relaxed text-white/70">{note}</p>}
      {measured.length > 0 && (
        <p className="font-jetbrains mt-1.5 text-[11px] leading-relaxed text-white/45">
          {measured.join(" · ")}
        </p>
      )}
    </div>
  );
}

/**
 * Sovereign mode's limits, straight from the backend constant
 * (service/ingest.py::SOVEREIGN_LIMITS) — served, never re-typed here, so the
 * two cannot drift. Rendered for every sovereign job, including one that `auto`
 * RESOLVED to sovereign without the user ever pressing the pill.
 */
export function SovereignLimits({ limits, heading }: { limits: string[]; heading?: string }) {
  if (limits.length === 0) return null;
  return (
    <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] px-4 py-3">
      <div className="font-jetbrains text-[11px] uppercase tracking-widest text-emerald-200/80">
        {heading ?? "sovereign mode · what it cannot do"}
      </div>
      <ul className="mt-2 space-y-1.5">
        {limits.map((l) => (
          <li key={l} className="font-jetbrains flex gap-2 text-[11px] leading-relaxed text-white/60">
            <span aria-hidden className="text-emerald-300/70">·</span>
            <span>{l}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
