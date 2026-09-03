"use client";

import type { Dispatch, SetStateAction } from "react";
import { castMembers, castRefusal, type CastSelection } from "../_state/cast";
import type { Action, Job, Speaker } from "../_state/machine";
import type { Pending } from "../_state/useIngestActions";
import VoiceNewCastPanel from "./VoiceNewCastPanel";
import VoiceNewSpeakerRow from "./VoiceNewSpeakerRow";

/** The speaker screen: one row per detected speaker, and the cast kickoff. */
export default function VoiceNewSpeakerStage({
  job, jobId, speakers, castSel, setCastSel, dispatch,
  playClip, playing, chooseSpeaker, pending,
  consented, setConsented, consentStatement, externalSource, startCast,
}: {
  job: Job;
  jobId: string | null;
  speakers: Speaker[];
  castSel: CastSelection;
  setCastSel: Dispatch<SetStateAction<CastSelection>>;
  dispatch: Dispatch<Action>;
  playClip: (url: string, id: string) => void;
  playing: string | null;
  chooseSpeaker: (sid: string) => void;
  pending: Pending;
  consented: boolean;
  setConsented: (v: boolean) => void;
  consentStatement: string;
  externalSource: boolean;
  startCast: () => void;
}) {
  const picked = castMembers(castSel, speakers);
  const castRefused = picked.length > 0 ? castRefusal(picked) : null;
  const multi = speakers.length > 1;
  return (
    <div className="mt-8">
      <h2 className="font-instrument text-2xl text-white">
        {job.mode === "sovereign" && !multi
          ? "This is what will be cloned."
          : multi ? "Who is in this recording?" : "Which voice is your character?"}
      </h2>
      {/* "N speakers detected" is a diarization result, and a HYPOTHESIS —
          `DiarizationResult.count_is_certain` is False by construction and has
          never been anything else. Measured on real recordings (see
          service/diarize.py's table): a hiss bed at 20 dB collapses two real
          speakers into one, and six speakers come back as six. So the count is
          worth stating and not worth asserting, and the single-speaker line in
          particular must not tell the user that everything audible IS one
          person — on noisy audio that is the case the diarizer gets wrong.
          Sovereign mode without the local diarizer has no result at all; its
          single entry is an assumption rather than even a finding. */}
      <p className="mt-1 max-w-2xl text-sm text-white/60">
        {job.mode === "sovereign" && !multi
          ? "Sovereign mode heard one speaker here, so everything audible will be treated as the same person. On a noisy recording that can be wrong — play the sample and check it is one voice before you continue."
          : `${speakers.length} speaker${speakers.length === 1 ? "" : "s"} detected — a hypothesis, not a headcount. Play a sample, then take one to the review ledger — or tick several and cast them all at once, from this one scan.`}
      </p>
      <div className="mt-5 space-y-2">
        {speakers.map((s, i) => (
          <VoiceNewSpeakerRow
            key={s.id}
            s={s}
            i={i}
            jobId={jobId}
            jobMode={job.mode}
            castSel={castSel}
            setCastSel={setCastSel}
            dispatch={dispatch}
            playClip={playClip}
            playing={playing}
            chooseSpeaker={chooseSpeaker}
            pending={pending}
          />
        ))}
      </div>

      {/* THE CAST. One recording, one paid scan, N Characters — and it
          clones straight through, so everything the review ledger would
          have asked (which emotions, which take, keep the audio?) is
          stated here instead of silently decided. */}
      {picked.length > 0 && (
        <VoiceNewCastPanel
          picked={picked}
          consented={consented}
          setConsented={setConsented}
          consentStatement={consentStatement}
          externalSource={externalSource}
          castRefused={castRefused}
          pending={pending}
          startCast={startCast}
        />
      )}
    </div>
  );
}
