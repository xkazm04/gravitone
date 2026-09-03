"use client";

import type { Dispatch } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { identityMeasured } from "../_state/casting";
import type { Action, Result, State, Stem } from "../_state/machine";
import { takeKey, type Take } from "../_state/useAudition";
import type { useCasting } from "../_state/useCasting";
import type { useCloneRoster } from "../_state/useCloneRoster";
import type { Pending } from "../_state/useIngestActions";
import VoiceNewCommitPanel from "./VoiceNewCommitPanel";
import VoiceNewLedgerRow from "./VoiceNewLedgerRow";

/** The review ledger: proposed voices, their drill-downs, and the commit box. */
export default function VoiceNewReviewStage({
  state, result, dispatch, failureNote, takes, requestTake,
  playClip, playing, auditionFor, setAuditionFor, boardFor, setBoardFor,
  casting, castSegments, roster, consented, setConsented, keepCorpus,
  setKeepCorpus, externalSource, pending, commit, startOver,
}: {
  state: State;
  result: Result;
  dispatch: Dispatch<Action>;
  failureNote: string | null;
  takes: Record<string, Take>;
  requestTake: (emotion: string, recipe: string, text: string) => Promise<string | null>;
  playClip: (url: string, id: string) => void;
  playing: string | null;
  auditionFor: string | null;
  setAuditionFor: (e: string | null) => void;
  boardFor: string | null;
  setBoardFor: (e: string | null) => void;
  casting: ReturnType<typeof useCasting>;
  castSegments: (next: Record<string, number[]>) => void;
  roster: ReturnType<typeof useCloneRoster>;
  consented: boolean;
  setConsented: (v: boolean) => void;
  keepCorpus: boolean;
  setKeepCorpus: (v: boolean) => void;
  externalSource: boolean;
  pending: Pending;
  commit: () => void;
  startOver: () => void;
}) {
  const { job, jobId, selected, auditions, assignments, dirty, mode, charName, extendCid } = state;
  const { characters, rosterFailed } = roster;
  // The pipeline scores every stem it writes; the column exists only when
  // that produced something to say (see identityMeasured).
  const showIdentity = identityMeasured(result.stems, dirty);
  const cols = showIdentity ? 8 : 7;

  /** Hear an emotion AS A VOICE — the clone of its chosen (or default) take,
   *  speaking the studio's line. One click, no drill-down: the audition is
   *  optional, but hearing one is not something a user should have to opt into
   *  a sub-view for. */
  async function hearAsVoice(st: Stem) {
    const rid = auditions[st.emotion] ?? "full";
    const id = `voice-${st.emotion}`;
    const known = takes[takeKey(st.emotion, rid, "")];
    if (known?.url) { playClip(known.url, id); return; }
    const url = await requestTake(st.emotion, rid, "");
    if (url) playClip(url, id);
  }

  return (
    <div className="mt-8">
      <div className="font-jetbrains flex flex-wrap gap-4 text-[12px] text-white/60">
        <span>{result.duration}s audio</span>
        <span>
          {/* Sovereign mode used to say "single speaker assumed (no local
              diarization)" unconditionally. It can now separate speakers
              offline (service/ingest.py::diarize_segments), so that was
              about to become false — and the count it reports is a
              hypothesis in that mode either way (assumed without the
              diarizer, clustered with it). Say the count, and say that. */}
          {`${result.speakers.length} speaker${result.speakers.length === 1 ? "" : "s"}`}
          {result.mode === "sovereign" && " · local scan, the count is not certain"}
          {" · "}target <span className="text-white">{result.target}</span>
        </span>
        <span>{result.utterances} utterances</span>
      </div>
      {/* What the pipeline DOES with a failed segment: nothing. The
          `usable` filter drops it, so it reaches no stem at all — the
          opposite of the "fell back to the baseline stem" this said. */}
      {failureNote && <ErrorBanner severity="warning">{failureNote}</ErrorBanner>}

      <div className="mt-6 flex items-end justify-between">
        <div>
          <h2 className="font-instrument text-2xl text-white">Proposed voices</h2>
          <p className="mt-1 max-w-2xl text-sm text-white/60">
            Keep or descope each emotion. “Short” stems hold under{" "}
            {result.min_stem}s of audio, the minimum this backend clones from.
            Play <span className="text-white/80">stem</span> to hear the speaker&apos;s own
            recording, or <span className="text-cyan-200">as a voice</span> to hear the
            clone itself — before anything is created. Open the{" "}
            <span className="text-white/80">segment count</span> to hear what a stem is
            spliced from, and to exclude or move a segment.
          </p>
        </div>
        <span className="font-jetbrains text-[12px] text-white/60">{selected.size} selected</span>
      </div>

      <div className="glass-panel mt-4 overflow-x-auto rounded-2xl">
        <table className="w-full min-w-[680px] border-collapse text-sm">
          <thead className="border-b border-white/8">
            <tr className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
              <th className="w-12 px-3 py-2" />
              <th className="px-3 py-2 text-left font-normal">emotion</th>
              <th className="px-3 py-2 text-left font-normal">length</th>
              <th className="px-3 py-2 text-left font-normal">segments</th>
              {/* What the pipeline MEASURED about the stem it just wrote.
                  It has always been served per stem and never shown. */}
              {showIdentity && (
                <th className="px-3 py-2 text-left font-normal">identity</th>
              )}
              <th className="px-3 py-2 text-left font-normal">vocal cue</th>
              {/* Two different things to listen to, so both are named:
                  the source recording, and the clone of it. */}
              <th className="w-44 px-3 py-2 text-left font-normal">listen</th>
              <th className="w-28 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {result.stems.map((st) => (
              <VoiceNewLedgerRow
                key={st.emotion}
                st={st}
                jobId={jobId}
                result={result}
                selected={selected}
                auditions={auditions}
                assignments={assignments}
                dirty={dirty}
                takes={takes}
                requestTake={requestTake}
                hearAsVoice={hearAsVoice}
                playClip={playClip}
                playing={playing}
                dispatch={dispatch}
                auditionFor={auditionFor}
                setAuditionFor={setAuditionFor}
                boardFor={boardFor}
                setBoardFor={setBoardFor}
                casting={casting}
                castSegments={castSegments}
                cols={cols}
                showIdentity={showIdentity}
              />
            ))}
          </tbody>
        </table>
      </div>
      {/* Why there is nothing to compare, when the backend knows. Named
          rather than silent, and never dressed up as a failure. */}
      {job?.recipes?.unavailable && (
        <p className="font-jetbrains mt-2 text-[11px] text-white/40">
          alternative takes aren&apos;t available for this scan — {job.recipes.unavailable}.
          You can still hear each emotion as a voice.
        </p>
      )}

      <VoiceNewCommitPanel
        mode={mode}
        dispatch={dispatch}
        characters={characters}
        rosterFailed={rosterFailed}
        charName={charName}
        extendCid={extendCid}
        selected={selected}
        consented={consented}
        setConsented={setConsented}
        keepCorpus={keepCorpus}
        setKeepCorpus={setKeepCorpus}
        externalSource={externalSource}
        pending={pending}
        commit={commit}
        startOver={startOver}
      />
    </div>
  );
}
