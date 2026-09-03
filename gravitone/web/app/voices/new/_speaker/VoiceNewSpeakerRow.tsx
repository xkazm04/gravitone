"use client";

import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/components/ui/Primitives";
import type { Action, Speaker } from "../_state/machine";
import type { CastSelection } from "../_state/cast";
import type { Pending } from "../_state/useIngestActions";
import SelectionSweep from "../_signal/SelectionSweep";

/** One detected speaker: hear them, tick them into the cast, or take them
 *  alone to the review ledger. */
export default function VoiceNewSpeakerRow({
  s, i, jobId, jobMode, castSel, setCastSel, dispatch,
  playClip, playing, chooseSpeaker, pending,
}: {
  s: Speaker;
  i: number;
  jobId: string | null;
  jobMode?: "cloud" | "sovereign";
  castSel: CastSelection;
  setCastSel: Dispatch<SetStateAction<CastSelection>>;
  dispatch: Dispatch<Action>;
  playClip: (url: string, id: string) => void;
  playing: string | null;
  chooseSpeaker: (sid: string) => void;
  pending: Pending;
}) {
  const on = castSel[s.id] !== undefined;
  return (
    <div className={`glass-panel relative overflow-hidden rounded-xl px-5 py-4 transition ${on ? "border border-cyan-400/25 bg-cyan-400/[0.04]" : ""}`}>
      {/* One accent on one state — the row's base hairline draws
          itself when this speaker is cast. Everything else on the
          row (sample, seconds, utterances, Review this →) is
          exactly as it was. */}
      {on && <SelectionSweep />}
      <div className="flex items-center gap-3">
        <input type="checkbox" checked={on} aria-label={`Cast ${s.id} as a character`}
          onChange={(e) => {
            setCastSel((cur) => {
              const next = { ...cur };
              if (e.target.checked) next[s.id] = next[s.id] ?? "";
              else delete next[s.id];
              return next;
            });
            dispatch({ type: "SET_ERROR", error: null });
          }}
          className="h-4 w-4 shrink-0 accent-cyan-300" />
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-slate-950" style={{ background: `hsl(${(i * 67) % 360} 85% 65%)` }}>{i + 1}</span>
        <button onClick={() => playClip(`/api/ingest/${jobId}/speaker-preview/${s.id}`, s.id)} aria-label="Play sample"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-cyan-300 text-[12px] text-slate-950 transition hover:brightness-110">
          {playing === s.id ? "⏸" : "▶"}
        </button>
        <div className="min-w-0 flex-1">
          <div className="font-jetbrains text-[12px] text-white/80">{s.id} · <span className="text-white">{s.seconds}s</span> · {s.utterances} utterances</div>
          {/* Quotation marks + italics mean "this is what they said".
              In sovereign mode nothing is transcribed, so sample_text
              is a finding about the recording and is set as one. */}
          {jobMode === "sovereign" ? (
            <div className="text-[12px] leading-snug text-white/50">{s.sample_text}</div>
          ) : (
            <div className="line-clamp-1 text-sm italic text-white/50">“{s.sample_text}”</div>
          )}
        </div>
        {/* The single-speaker route, unchanged: this speaker alone,
            through the review ledger, exactly as before. */}
        <Button onClick={() => chooseSpeaker(s.id)} disabled={pending !== null}
          className="shrink-0 cursor-pointer px-4 py-2 text-[13px]">
          {pending === `speaker:${s.id}` ? "selecting…" : "Review this →"}
        </Button>
      </div>
      {on && (
        <div className="mt-3 flex flex-wrap items-center gap-2 pl-7">
          <label htmlFor={`cast-name-${s.id}`} className="font-jetbrains text-[11px] text-cyan-200/80">
            becomes
          </label>
          <input id={`cast-name-${s.id}`} value={castSel[s.id] ?? ""}
            placeholder="Character name"
            onChange={(e) => {
              const v = e.target.value;
              setCastSel((cur) => ({ ...cur, [s.id]: v }));
              dispatch({ type: "SET_ERROR", error: null });
            }}
            className="font-hanken w-56 rounded-xl border border-white/12 bg-white/[0.03] px-3 py-1.5 text-sm text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none" />
        </div>
      )}
    </div>
  );
}
