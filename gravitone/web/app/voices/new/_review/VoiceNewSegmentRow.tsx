"use client";

import { useCallback, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import TakePlayer from "@/components/ui/TakePlayer";
import { emotionMeta } from "@/lib/emotions";
import { useMounted } from "@/lib/useMounted";
import { assetRefusal } from "../_state/failures";
import { labelSource, type SegmentRow } from "../_state/casting";

/** Palette for where a label came from. Amber is reserved for the two cases
 *  where the pipeline was UNSURE and did not (or could not) buy a second
 *  opinion — the same amber this repo uses for "succeeded, with caveats". */
const SOURCE_STYLE: Record<string, string> = {
  paid: "border-cyan-400/30 bg-cyan-400/10 text-cyan-100/90",
  quick: "border-white/10 text-white/45",
  unsure: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  none: "border-white/10 text-white/40",
};

/** One segment: hear it, read what the scan said about it, cast it. */
export default function VoiceNewSegmentRow(props: {
  row: SegmentRow;
  jobId: string;
  hue: number;
  others: string[];
  busy: boolean;
  onToggle: () => void;
  onMove: (to: string) => void;
}) {
  const { row, jobId, hue, others, busy } = props;
  const label = emotionMeta(row.emotion);
  const src = `/api/ingest/${jobId}/segment/${row.i}`;
  // What the SERVICE says about audio it would not serve. The transport can
  // only report "unplayable" — it never sees the body — and this row is the one
  // place where the difference between "measured as not the target speaker",
  // "could not be decoded" and "this session has expired" is the whole answer.
  const [refusal, setRefusal] = useState<string | null>(null);
  const mounted = useMounted();
  const onFail = useCallback(() => {
    void assetRefusal(src).then((detail) => {
      if (detail && mounted.current) setRefusal(detail);
    });
  }, [src, mounted]);
  return (
    <li
      className={`glass-panel rounded-xl px-3 py-2.5 transition ${
        row.assigned ? "" : "opacity-60"
      }`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex shrink-0 cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="accent-cyan-300"
            checked={row.assigned}
            disabled={!row.available || busy}
            onChange={props.onToggle}
            aria-label={`${row.assigned ? "Exclude" : "Include"} segment ${row.i} — ${
              label.label
            }, ${row.dur}s`}
          />
          <span className="font-jetbrains text-[11px] tabular-nums text-white/45">
            #{row.i}
          </span>
        </label>

        <span
          className="font-jetbrains inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-white/70"
          title={row.foreign ? "labelled as another emotion" : undefined}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${label.hue} 85% 62%)` }} />
          {label.label}
          {row.foreign && <span className="text-white/40">· moved</span>}
        </span>

        <span className="font-jetbrains shrink-0 text-[11px] tabular-nums text-white/55">
          {row.dur}s
        </span>
        {/* Confidence is the classifier's own number and only means anything
            when there is a classifier: sovereign mode labels everything 1.0. */}
        {row.confidence > 0 && row.confidence < 1 && (
          <span className="font-jetbrains shrink-0 text-[11px] tabular-nums text-white/40">
            {Math.round(row.confidence * 100)}% sure
          </span>
        )}
        {/* WHERE the label came from. The scan already records whether a
            segment's emotion is the cheap classifier's first guess, a paid
            second opinion, or a first guess whose second opinion was skipped
            for budget / failed outright — and the board rendered all four the
            same, so a guess read exactly like a checked answer. */}
        {(() => {
          const src = labelSource(row);
          if (!src) return null;
          return (
            <span
              title={src.title}
              className={`font-jetbrains shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${SOURCE_STYLE[src.tone]}`}
            >
              {src.text}
            </span>
          );
        })()}
        {row.outlier === "flagged" && (
          <span className="font-jetbrains shrink-0 rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">
            unlike the rest
          </span>
        )}
        {row.blocked && (
          <span className="font-jetbrains shrink-0 rounded bg-rose-400/10 px-1.5 py-0.5 text-[10px] text-rose-200">
            {row.outlier === "dropped" ? "not this speaker" : "no audio"}
          </span>
        )}

        <span className="ml-auto flex min-w-[13rem] flex-1 justify-end">
          {row.available ? (
            <TakePlayer
              src={src}
              hue={hue}
              compact
              className="w-full max-w-xs"
              label={`segment ${row.i}, ${label.label}`}
              onFail={onFail}
            />
          ) : row.ok !== false && !row.failure ? (
            // Rejected but extracted: the audio exists and hearing it is the
            // only way to check the verdict.
            <TakePlayer
              src={src}
              hue={hue}
              compact
              className="w-full max-w-xs"
              label={`rejected segment ${row.i}`}
              onFail={onFail}
            />
          ) : (
            <span className="font-jetbrains text-[11px] text-white/35">no audio to play</span>
          )}
        </span>

        {others.length > 0 && row.available && row.assigned && (
          <label className="shrink-0">
            <span className="sr-only">Move segment {row.i} to another emotion</span>
            <select
              value=""
              disabled={busy}
              onChange={(e) => { if (e.target.value) props.onMove(e.target.value); }}
              className="font-jetbrains rounded-lg border border-white/12 bg-[#0d1017] px-2 py-1 text-[11px] text-white/70 focus:outline-none disabled:opacity-40"
            >
              <option value="">move to…</option>
              {others.map((e) => (
                <option key={e} value={e}>{emotionMeta(e).label}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {(row.text || row.cue || row.blocked) && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 pl-1 text-[11px] leading-snug">
          {row.text && <span className="italic text-white/45">“{row.text}”</span>}
          {row.cue && <span className="text-white/35">{row.cue}</span>}
          {row.blocked && <span className="text-rose-200/70">{row.blocked}</span>}
        </div>
      )}
      {/* Amber, not rose: the segment did not play, and the scan is fine. */}
      {refusal && (
        <ErrorBanner severity="warning" className="mt-1.5">
          segment {row.i} wouldn&apos;t play — {refusal}
        </ErrorBanner>
      )}
    </li>
  );
}
