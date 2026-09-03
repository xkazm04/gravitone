"use client";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { emotionMeta } from "@/lib/emotions";
import type { Result, Stem } from "../_state/machine";
import {
  boardRows, castableElsewhere, moveSegment, shortBy, stemProgress,
  toggleSegment, wouldEmpty,
} from "../_state/casting";
import VoiceNewSegmentRow from "./VoiceNewSegmentRow";

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
          <VoiceNewSegmentRow
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
              <VoiceNewSegmentRow
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
