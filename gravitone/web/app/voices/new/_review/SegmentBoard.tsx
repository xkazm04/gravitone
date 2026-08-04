"use client";

import { useCallback, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import TakePlayer from "@/components/ui/TakePlayer";
import { emotionMeta } from "@/lib/emotions";
import { useMounted } from "@/lib/useMounted";
import { assetRefusal } from "../_state/failures";
import type { Result, Stem } from "../_state/machine";
import {
  boardRows, castableElsewhere, labelSource, moveSegment, shortBy, stemProgress,
  toggleSegment, wouldEmpty, type SegmentRow,
} from "../_state/casting";

/** Palette for where a label came from. Amber is reserved for the two cases
 *  where the pipeline was UNSURE and did not (or could not) buy a second
 *  opinion — the same amber this repo uses for "succeeded, with caveats". */
const SOURCE_STYLE: Record<string, string> = {
  paid: "border-cyan-400/30 bg-cyan-400/10 text-cyan-100/90",
  quick: "border-white/10 text-white/45",
  unsure: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  none: "border-white/10 text-white/40",
};

/**
 * The Segment Casting Board for ONE ledger row.
 *
 * The stem was the one part of this flow the user had no authority over. The
 * scan has always cut the recording into segments and reported each one's
 * emotion, confidence, cue and length — then spliced them into a single number
 * on screen, so a mislabelled laugh or a stem 0.4s under the clone minimum was
 * a dead end shown as a grey badge.
 *
 * Three commitments, in the order they matter:
 *   * **Hear first.** Every segment plays through the repo's one transport
 *     (<TakePlayer compact>), including the ones the pipeline REJECTED — those
 *     are exactly the ones somebody wants to check. Read-only is a complete
 *     state: a user who only expands the row has already learned why the stem
 *     is what it is (and what the "mixed" note means).
 *   * **Watch the line.** Excluding or moving a segment re-splices server-side,
 *     debounced, and the seconds bar and the eligible badge move with the
 *     MEASURED result — so a short stem can be watched crossing the minimum
 *     instead of being re-uploaded and hoped about.
 *   * **Nothing is unwound in silence.** "Reset to proposed" is always on
 *     screen, a refusal is the service's own sentence, and a row that is no
 *     longer the pipeline's splice says so.
 *
 * Cross-recording pooling is NOT here. The corpus (a character's kept audio) is
 * the seam a future pool would come from; this board only ever addresses the
 * segments of the recording in front of it.
 */
export default function SegmentBoard(props: {
  jobId: string;
  stem: Stem;
  result: Result;
  minStem: number;
  /** {emotion -> segment indices} for the WHOLE scan: a move touches two rows. */
  assignments: Record<string, number[]>;
  edited: boolean;
  busy: boolean;
  error: string | null;
  /** Send an assignment map to the debounced re-splice. */
  onCast: (assignments: Record<string, number[]>) => void;
  onReset: () => void;
  onDismissError: () => void;
  onClose: () => void;
}) {
  const { jobId, stem, result, minStem, assignments, edited, busy, error } = props;
  const emotion = stem.emotion;
  const meta = emotionMeta(emotion);
  const assigned = assignments[emotion] ?? [];
  const rows = boardRows(result, emotion, assigned);
  const elsewhere = castableElsewhere(result, emotion, assigned);
  const others = result.stems.map((s) => s.emotion).filter((e) => e !== emotion);
  const gap = shortBy(stem, minStem);
  const fill = stemProgress(stem.seconds, minStem);

  function toggle(i: number) {
    const next = { [emotion]: toggleSegment(assigned, i) };
    // Refused by the service by name; there is no reason to make the user learn
    // that by being refused. Descope is the verb for "no stem at all".
    if (wouldEmpty(next)) return;
    props.onCast(next);
  }

  function move(i: number, to: string) {
    const next = moveSegment(assignments, i, emotion, to);
    if (!Object.keys(next).length) return;
    if (wouldEmpty(next)) return;
    props.onCast(next);
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-jetbrains flex items-center gap-2 text-[11px] uppercase tracking-widest text-white/55">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${meta.hue} 85% 62%)` }} />
            segments in the {meta.label} stem
            {edited && (
              <span className="rounded bg-cyan-400/10 px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-cyan-200">
                you cast this one
              </span>
            )}
          </div>
          <p className="mt-1 max-w-xl text-[13px] leading-snug text-white/60">
            This stem is spliced from the segments ticked below. Play any of them —
            including the ones the scan rejected — then exclude or move one and
            watch the length re-measure.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={props.onReset}
            disabled={busy}
            className="font-jetbrains cursor-pointer rounded-full border border-white/12 px-3 py-1 text-[11px] text-white/60 transition hover:text-white disabled:cursor-default disabled:opacity-40"
          >
            ↺ reset to proposed
          </button>
          <button
            onClick={props.onClose}
            className="font-jetbrains cursor-pointer rounded-full border border-white/12 px-3 py-1 text-[11px] text-white/60 transition hover:text-white"
          >
            close
          </button>
        </div>
      </div>

      {/* The seconds bar: the clone minimum drawn as a place a stem can cross. */}
      <div className="mt-4 max-w-xl">
        <div className="font-jetbrains flex items-center justify-between text-[11px] text-white/55">
          <span>
            {busy ? "re-splicing…" : `${stem.seconds}s of ${minStem}s minimum`}
          </span>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              stem.eligible
                ? "bg-emerald-400/10 text-emerald-200"
                : "bg-amber-400/10 text-amber-200"
            }`}
          >
            {stem.eligible ? "clonable" : gap !== null ? `${gap}s short` : "too short"}
          </span>
        </div>
        <div
          className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/10"
          role="progressbar"
          aria-valuenow={Math.round(fill * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${meta.label} stem length against the ${minStem} second clone minimum`}
        >
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              stem.eligible ? "bg-emerald-300" : "bg-amber-300"
            }`}
            style={{ width: `${fill * 100}%` }}
          />
        </div>
        {stem.note && (
          <p className="mt-2 text-[11px] leading-snug text-amber-200/75">{stem.note}</p>
        )}
      </div>

      {error && (
        <ErrorBanner severity="warning">
          <span className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <button
              onClick={props.onDismissError}
              className="shrink-0 cursor-pointer underline decoration-dotted"
            >
              dismiss
            </button>
          </span>
        </ErrorBanner>
      )}

      <ul className="mt-4 space-y-2">
        {rows.map((row) => (
          <SegmentRowView
            key={row.i}
            row={row}
            jobId={jobId}
            hue={meta.hue}
            others={others}
            busy={busy}
            onToggle={() => toggle(row.i)}
            onMove={(to) => move(row.i, to)}
          />
        ))}
        {rows.length === 0 && (
          <li className="font-jetbrains text-[11px] text-white/40">
            this scan published no segment labels, so its stems cannot be re-cast
          </li>
        )}
      </ul>

      {elsewhere.length > 0 && (
        <details className="mt-4 border-t border-white/8 pt-3">
          <summary className="font-jetbrains cursor-pointer text-[11px] text-white/50 transition hover:text-white">
            cast a segment from another emotion into {meta.label} ({elsewhere.length}) →
          </summary>
          <p className="font-jetbrains mt-2 text-[10px] leading-snug text-white/40">
            The label is the classifier&apos;s opinion, not a verdict. Moving a segment
            here splices its audio into this stem and takes it out of the other one.
          </p>
          <ul className="mt-2 space-y-2">
            {elsewhere.map((row) => (
              <SegmentRowView
                key={`in-${row.i}`}
                row={row}
                jobId={jobId}
                hue={meta.hue}
                others={[]}
                busy={busy}
                onToggle={() => props.onCast(moveSegment(assignments, row.i, row.emotion, emotion))}
                onMove={() => undefined}
              />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** One segment: hear it, read what the scan said about it, cast it. */
function SegmentRowView(props: {
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
