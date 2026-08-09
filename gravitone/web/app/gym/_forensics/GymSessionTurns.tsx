"use client";

// The transcript half of the inspector: one row per turn, and the finding chips
// that pin a concern to the moment it is about. Clicking a turn seeks BOTH
// tracks; nothing here ever autoplays.

import type { Finding } from "../_gym/diagnose";
import { fmtS } from "../_gym/data";
import type { RecordedTurn } from "../_gym/types";

export const MONO_LABEL = "font-jetbrains text-[11px] uppercase tracking-[0.18em]";

/** at_s as a m:ss mono timestamp — the timeline's clock, not a duration. */
export function fmtAt(atS: number): string {
  const s = Math.max(0, Math.floor(atS));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One turn of the dialogue: candidate hugs the left hairline, the agent is
 *  indented on cyan. The whole row is a button — clicking seeks both tracks
 *  to at_s, and never autoplays. */
export function TurnRow({
  turn,
  index,
  findings,
  onSeek,
}: {
  turn: RecordedTurn;
  index: number;
  findings: Finding[];
  onSeek: (atS: number) => void;
}) {
  const isAgent = turn.role === "agent";
  return (
    <li>
      <button
        type="button"
        onClick={() => onSeek(turn.at_s)}
        title={`seek both tracks to ${fmtAt(turn.at_s)}`}
        className={`block w-full rounded-r-lg border-l py-2 pl-4 text-left transition hover:bg-white/[0.03] ${
          isAgent ? "ml-8 border-cyan-400/40" : "border-white/25"
        }`}
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className={`${MONO_LABEL} ${isAgent ? "text-cyan-300/80" : "text-white/45"}`}>
            {isAgent ? "agent" : "caller"}
          </span>
          <span className="font-jetbrains text-[11px] text-white/45">{fmtAt(turn.at_s)}</span>
          {!isAgent && typeof turn.transcribe_s === "number" && (
            <span className="font-jetbrains text-[11px] text-white/45">
              heard in {fmtS(turn.transcribe_s)}
            </span>
          )}
          {isAgent && typeof turn.answer_s === "number" && (
            <span className="font-jetbrains text-[11px] text-white/45">
              answered in {fmtS(turn.answer_s)}
            </span>
          )}
          {turn.interrupted && (
            <span className="font-jetbrains rounded-full border border-rose-400/30 bg-rose-400/5 px-2 py-0.5 text-[11px] text-rose-300">
              cut off
            </span>
          )}
          {findings.map((f) => (
            <FindingChip key={f.id} finding={f} />
          ))}
        </div>
        <p className="font-hanken mt-1 text-[15px] text-slate-200">{turn.text}</p>
      </button>
    </li>
  );
}

/** A finding as a chip: rose for a concern, amber for a notice; the summary
 *  rides in the title so the chip stays one word wide. */
export function FindingChip({ finding, className = "" }: { finding: Finding; className?: string }) {
  const palette =
    finding.severity === "concern"
      ? "border-rose-400/30 bg-rose-400/5 text-rose-300"
      : "border-amber-400/30 bg-amber-400/5 text-amber-300";
  return (
    <span
      title={finding.summary}
      className={`font-jetbrains inline-flex rounded-full border px-2 py-0.5 text-[11px] ${palette} ${className}`}
    >
      {finding.kind}
    </span>
  );
}
