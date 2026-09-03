"use client";

import { Fragment, type Dispatch } from "react";
import dynamic from "next/dynamic";
import EmotionIcon from "@/components/ui/EmotionIcon";
import { emotionMeta } from "@/lib/emotions";
import { candidates, recipeById } from "../_state/audition";
import { isEdited, stemIdentity } from "../_state/casting";
import type { Action, Result, Stem } from "../_state/machine";
import { takeKey, type Take } from "../_state/useAudition";
import type { useCasting } from "../_state/useCasting";
import VoiceNewPanelLoading from "../_shell/VoiceNewPanelLoading";
// The two review drill-downs are ~600 lines (plus framer-motion, through
// _loaders/ScanReport) reachable only from an EXPANDED ledger row — and they were
// statically imported into a first paint that is a dropzone. Neither needs SSR:
// this is a client page, and both mount from a click.
const SegmentBoard = dynamic(() => import("./SegmentBoard"), {
  ssr: false, loading: () => <VoiceNewPanelLoading label="opening the casting board…" />,
});
const AuditionPanel = dynamic(() => import("./AuditionPanel"), {
  ssr: false, loading: () => <VoiceNewPanelLoading label="opening the audition room…" />,
});

/** One proposed voice in the review ledger, plus the two drill-downs it can
 *  open underneath itself. */
export default function VoiceNewLedgerRow({
  st, jobId, result, selected, auditions, assignments, dirty, takes, requestTake,
  hearAsVoice, playClip, playing, dispatch, auditionFor, setAuditionFor,
  boardFor, setBoardFor, casting, castSegments, cols, showIdentity,
}: {
  st: Stem;
  jobId: string | null;
  result: Result;
  selected: Set<string>;
  auditions: Record<string, string>;
  assignments: Record<string, number[]>;
  dirty: string[];
  takes: Record<string, Take>;
  requestTake: (emotion: string, recipe: string, text: string) => Promise<string | null>;
  hearAsVoice: (st: Stem) => void;
  playClip: (url: string, id: string) => void;
  playing: string | null;
  dispatch: Dispatch<Action>;
  auditionFor: string | null;
  setAuditionFor: (e: string | null) => void;
  boardFor: string | null;
  setBoardFor: (e: string | null) => void;
  casting: ReturnType<typeof useCasting>;
  castSegments: (next: Record<string, number[]>) => void;
  cols: number;
  showIdentity: boolean;
}) {
  const on = selected.has(st.emotion);
  const m = emotionMeta(st.emotion);
  // The candidate takes for this row (>=2 or nothing at all),
  // the one the ear chose, and the state of the quick clone.
  const takesFor = candidates(st);
  const chosen = recipeById(st, auditions[st.emotion]);
  const quick = takes[takeKey(st.emotion, auditions[st.emotion] ?? "full", "")];
  const open = auditionFor === st.emotion;
  // The segment layer only exists once the backend published
  // it; absent = the row simply does not expand.
  const board = boardFor === st.emotion;
  const castable = Boolean(result.segments?.length
    && assignments[st.emotion]?.length);
  const cast = isEdited(dirty, st.emotion);
  return (
    <Fragment>
    <tr className={`border-b border-white/5 transition hover:bg-white/[0.03] ${on ? "" : "opacity-55"}`}>
      <td className="px-3 py-2">
        <span className="grid h-9 w-9 place-items-center overflow-hidden rounded-lg border border-white/8 bg-black/40">
          <EmotionIcon emotion={st.emotion} size={20} dim={!on} />
        </span>
      </td>
      <td className="px-3 py-2">
        <span className="flex items-center gap-2 text-sm font-medium text-white">
          <span className="h-2 w-2 rounded-full" style={{ background: `hsl(${m.hue} 85% 62%)` }} />{m.label}
          {!st.eligible && <span className="font-jetbrains rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">short</span>}
          {st.note && <span className="font-jetbrains rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">mixed</span>}
          {/* A stem the USER assembled is never presented as
              the pipeline's proposal. */}
          {cast && <span className="font-jetbrains rounded bg-cyan-400/10 px-1.5 py-0.5 text-[10px] text-cyan-200">cast</span>}
        </span>
        {st.note && <span className="mt-1 block max-w-[26rem] text-[11px] leading-snug text-amber-200/70">{st.note}</span>}
        {/* What the EAR chose, stated where the emotion is
            named — a decision the user made must be visible
            at commit time, not buried in a closed panel. */}
        {chosen && !chosen.default && (
          <span className="font-jetbrains mt-1 flex items-center gap-1.5 text-[10px] text-cyan-200/85">
            cloning “{chosen.label}” · {chosen.seconds}s
            <button
              onClick={() => dispatch({ type: "CHOOSE_RECIPE", emotion: st.emotion, recipeId: null })}
              title="clone the full stem instead"
              className="cursor-pointer text-white/45 underline decoration-dotted transition hover:text-white"
            >
              undo
            </button>
          </span>
        )}
      </td>
      <td className="font-jetbrains px-3 py-2 text-[12px] text-white/70">{st.seconds}s</td>
      <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">
        {castable ? (
          <button onClick={() => setBoardFor(board ? null : st.emotion)}
            aria-expanded={board}
            aria-label={`${board ? "Hide" : "Show"} the ${st.segments} segments in the ${m.label} stem`}
            title="what this stem is spliced from — play, exclude or move each segment"
            className="cursor-pointer underline decoration-dotted underline-offset-4 transition hover:text-white">
            {st.segments} {board ? "▾" : "▸"}
          </button>
        ) : (
          st.segments
        )}
      </td>
      {showIdentity && (() => {
        const cell = stemIdentity(st, cast, result.fidelity?.measures);
        return (
          <td className="font-jetbrains px-3 py-2 text-[12px]" title={cell.title}>
            <span className={
              cell.tone === "measured" ? "tabular-nums text-cyan-200/85"
              : cell.tone === "recast" ? "text-white/45"
              : "text-white/35"}>
              {cell.text}
            </span>
          </td>
        );
      })()}
      <td className="px-3 py-2 text-[12px] italic text-white/50">{st.cues[0] ? `“${st.cues[0]}”` : "—"}</td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* SOURCE audio: the speaker's own recording. */}
          <button onClick={() => playClip(`/api/ingest/${jobId}/preview/${st.emotion}`, `stem-${st.emotion}`)}
            aria-label={`${playing === `stem-${st.emotion}` ? "Pause" : "Play"} the source recording for ${m.label}`}
            title="source audio — the speaker's own recording"
            className="font-jetbrains flex cursor-pointer items-center gap-1.5 rounded-full border border-white/15 px-2.5 py-1 text-[11px] text-white/75 transition hover:border-white/35 hover:text-white">
            <span aria-hidden>{playing === `stem-${st.emotion}` ? "⏸" : "▶"}</span>
            stem
          </button>
          {/* CLONED voice: what committing this row would make. */}
          <button onClick={() => void hearAsVoice(st)}
            disabled={quick?.loading}
            aria-label={`${playing === `voice-${st.emotion}` ? "Pause" : "Play"} ${m.label} as a cloned voice`}
            title="cloned voice — synthesized from this stem, before anything is committed"
            className="font-jetbrains flex cursor-pointer items-center gap-1.5 rounded-full border border-cyan-400/35 bg-cyan-400/10 px-2.5 py-1 text-[11px] text-cyan-100 transition hover:bg-cyan-400/20 disabled:cursor-default disabled:opacity-45">
            <span aria-hidden>{quick?.loading ? "◌" : playing === `voice-${st.emotion}` ? "⏸" : "▶"}</span>
            {quick?.loading ? "cloning…" : "as a voice"}
          </button>
        </div>
        {/* A refused or failed audition says so here, in amber:
            nothing about the ledger row has gone wrong. */}
        {quick?.error && (
          <span className="font-jetbrains mt-1 block max-w-[16rem] text-[10px] leading-snug text-amber-200/80">
            {quick.error}
            {quick.busySec ? ` — retry in ${quick.busySec}s.` : ""}
          </span>
        )}
        {takesFor.length > 0 && (
          <button onClick={() => setAuditionFor(open ? null : st.emotion)}
            aria-expanded={open}
            aria-label={`${open ? "Close" : "Open"} the audition for ${m.label}`}
            className="font-jetbrains mt-1.5 cursor-pointer text-[10px] text-white/45 underline decoration-dotted transition hover:text-white">
            {open ? "close audition" : `compare ${takesFor.length} takes →`}
          </button>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <button onClick={() => dispatch({ type: "TOGGLE_EMOTION", emotion: st.emotion })} aria-pressed={on}
          className={`font-jetbrains rounded-lg border px-2.5 py-1 text-[11px] transition ${on ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/55 hover:text-white"}`}>
          {on ? "✓ keep" : "descope"}
        </button>
      </td>
    </tr>
    {board && (
      <tr className="border-b border-white/5">
        <td colSpan={cols} className="px-3 pb-4 pt-1">
          <SegmentBoard
            jobId={jobId!}
            stem={st}
            result={result}
            minStem={result.min_stem}
            assignments={assignments}
            edited={cast}
            busy={casting.busy}
            error={casting.error}
            onCast={castSegments}
            onReset={casting.reset}
            onDismissError={casting.dismiss}
            onClose={() => setBoardFor(null)}
          />
        </td>
      </tr>
    )}
    {open && (
      <tr className="border-b border-white/5">
        <td colSpan={cols} className="px-3 pb-4 pt-1">
          <AuditionPanel
            emotion={st.emotion}
            label={m.label}
            hue={m.hue}
            recipes={takesFor}
            chosenId={auditions[st.emotion]}
            takes={takes}
            request={requestTake}
            play={playClip}
            playing={playing}
            onChoose={(recipeId) => dispatch({ type: "CHOOSE_RECIPE", emotion: st.emotion, recipeId })}
            onClose={() => setAuditionFor(null)}
          />
        </td>
      </tr>
    )}
    </Fragment>
  );
}
