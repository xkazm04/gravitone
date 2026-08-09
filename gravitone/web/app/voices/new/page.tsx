"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import AppFrame from "@/components/ui/AppFrame";
import { useAuth } from "@/lib/useAuth";
import { useMounted } from "@/lib/useMounted";
import { CONSENT_STATEMENT, EXTERNAL_CONSENT_STATEMENT } from "@/lib/consent";
import WaveformLab from "./_loaders/WaveformLab";
import { DetectionFinding, SovereignLimits, segmentFailureNote, type LoaderData } from "./_loaders/ScanReport";
import {
  reducer, initialState, POLLING_PHASES, WATCH_PHASES,
  type CastResult, type Job,
} from "./_state/machine";
import { type CastSelection } from "./_state/cast";
import { useCasting } from "./_state/useCasting";
import { useIngestJob } from "./_state/useIngestJob";
import { useAudition } from "./_state/useAudition";
import { useLinkProbe } from "./_state/useLinkProbe";
import { useBackpressure } from "./_state/useBackpressure";
import { useClipTransport } from "./_state/useClipTransport";
import { useCloneRoster } from "./_state/useCloneRoster";
import { useIngestActions } from "./_state/useIngestActions";
import { useIngestModes } from "./_state/useIngestModes";
import { useIngestReset } from "./_state/useIngestReset";
import { useVaultReceipt } from "./_state/useVaultReceipt";
import VoiceNewHeader from "./_shell/VoiceNewHeader";
import VoiceNewNotices from "./_shell/VoiceNewNotices";
import VoiceNewUploadStage, { type SourceTab } from "./_upload/VoiceNewUploadStage";
import VoiceNewSpeakerStage from "./_speaker/VoiceNewSpeakerStage";
import VoiceNewCastingStage from "./_speaker/VoiceNewCastingStage";
import VoiceNewReviewStage from "./_review/VoiceNewReviewStage";
import VoiceNewCommittingStage from "./_complete/VoiceNewCommittingStage";
import VoiceNewExpiredStage from "./_complete/VoiceNewExpiredStage";
import VoiceNewCastComplete from "./_complete/VoiceNewCastComplete";
import VoiceNewCommitComplete from "./_complete/VoiceNewCommitComplete";

// Phases where a scanned recording is on screen and the mode that produced it
// is still load-bearing for what the user is reading.
const SCAN_PHASES: ReadonlySet<string> = new Set(["processing", "speaker", "review"]);

export default function NewCharacterPage() {
  const { user } = useAuth();

  // The whole create-flow state graph in one reducer.
  const [state, dispatch] = useReducer(reducer, initialState);
  const { phase, jobId, job, result, selected, error,
    mode, charName, extendCid, committedCid, created, auditions } = state;

  // Ephemeral input/UI state — not part of the flow's state graph.
  const [consented, setConsented] = useState(false); // Voice Vault attestation
  // The retention opt-in, and it lives at the CONSENT moment rather than at
  // upload on purpose. The service takes `corpus` at both points (scan's Form
  // field and the commit body, the commit winning — ingest_api.py:1038/1583);
  // asking at upload would demand a retention decision before the user has seen
  // what the recording even contains, and the commit would override it anyway.
  // So the scan sends nothing (service default: off) and every commit sends an
  // EXPLICIT true/false — the job's outcome then names what this checkbox said.
  const [keepCorpus, setKeepCorpus] = useState(false);
  // Where THIS job's audio came from, as the backend recorded it — never from
  // which tab the user happened to click, which a reload would forget.
  const externalSource = job?.source?.kind === "url";
  const consentStatement = externalSource ? EXTERNAL_CONSENT_STATEMENT : CONSENT_STATEMENT;
  // THE CASTING BOARD's selection: {speaker id -> the name typed for it}. Pure
  // input state (it exists only between the speaker screen appearing and the
  // cast starting), so it lives here rather than in the flow's state graph —
  // the same rule the consent checkbox and the chosen File follow.
  const [castSel, setCastSel] = useState<CastSelection>({});
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  // The link door. `linkTab` is which input is on screen; `link` is the pasted
  // URL. Both are ephemeral input state — the moment a scan starts, the flow's
  // state graph knows only that a job exists, exactly as with a file.
  const [srcTab, setSrcTab] = useState<SourceTab>("file");
  const [link, setLink] = useState("");
  // The paste-time verdict — metadata only, no media moves. It is what makes
  // "47-minute video, we'll clone the first 15 minutes" a sentence the user
  // reads BEFORE the download rather than a surprise after it.
  const linkProbe = useLinkProbe(link, phase === "upload" && srcTab === "link");
  const linkUsable = linkProbe.status === "done" && linkProbe.verdict.ok;
  // auto = cloud quality when the backend has API keys, else local.
  // sovereign = force local-only: the recording never leaves the machine.
  const [ingestMode, setIngestMode] = useState<"auto" | "sovereign">("auto");
  // Who this flow can extend, and the character it was opened FROM.
  const roster = useCloneRoster(phase, dispatch);
  // What the backend says each mode does, for the privacy-mode panel.
  const modes = useIngestModes();

  const fileRef = useRef<HTMLInputElement>(null);
  const mounted = useMounted();
  // The one transport everything on this screen plays through.
  const clips = useClipTransport();
  const { transport, playing, clipRefusal, playClip } = clips;
  // Which ledger row has its Audition Room open. Exactly one at a time, and null
  // is the normal state: the fast path is still keep/descope then commit.
  const [auditionFor, setAuditionFor] = useState<string | null>(null);
  const { takes, request: requestTake } = useAudition(jobId);
  // Which ledger row has its Casting Board open. Independent of the Audition
  // Room: one answers "what is in this stem", the other "what does it sound
  // like as a voice", and a user can want both about the same emotion.
  const [boardFor, setBoardFor] = useState<string | null>(null);
  const casting = useCasting(
    jobId,
    useCallback((cast: CastResult) => dispatch({ type: "CAST_SYNCED", cast }), []),
  );

  /** Cast segments into stems: the checkbox answers immediately, the re-splice
   *  behind it is debounced, and the LENGTH only ever moves when the service
   *  answers with what it measured. */
  function castSegments(next: Record<string, number[]>) {
    dispatch({ type: "CAST_SEGMENTS", assignments: next });
    casting.cast(next);
  }

  const busy = useBackpressure({
    mounted,
    clearError: () => dispatch({ type: "SET_ERROR", error: null }),
  });

  // The two ways out of a job: tear it down, or leave it for a new recording.
  const { cancelFailed, cancelCommit, startOver, scanAnother } = useIngestReset({
    jobId, dispatch, setFile, setKeepCorpus, setCastSel, setConsented,
    clearBusy: busy.clear, clearClipRefusal: clips.clearRefusal,
  });

  // Every call this flow makes that CHANGES something server-side, behind the
  // one re-entrancy gate.
  const {
    pending, acceptFile, startScan, startLinkScan, chooseSpeaker, startCast,
    commit, retryBusy,
  } = useIngestActions({
    jobId, job, result, selected, mode, charName, extendCid, auditions,
    characters: roster.characters, file, setFile, link, ingestMode, castSel,
    consented, consentStatement, keepCorpus, dispatch, busy,
    pauseTransport: transport.pause,
  });

  // ONE poller for the analyze leg, the commit leg AND the review watch — the
  // last of which exists because a job dies of idleness while it is being
  // reviewed (see WATCH_PHASES) and the screen used to keep looking alive.
  const [pollStalled, setPollStalled] = useState(false);
  const watching = WATCH_PHASES.has(phase);
  useIngestJob({
    jobId,
    enabled: POLLING_PHASES.has(phase) || watching,
    watch: watching,
    onJob: (j: Job) => dispatch({ type: "JOB_POLLED", job: j }),
    onExpired: () => dispatch({ type: "JOB_EXPIRED" }),
    onStalled: setPollStalled,
  });
  // Reset the degraded-connection notice whenever polling stops/starts.
  useEffect(() => { setPollStalled(false); }, [jobId, phase]);

  const vaultWarn = useVaultReceipt({
    phase, user, created, pendingCommit: state.pendingCommit, cast: job?.cast,
  });

  const loaderData: LoaderData = { steps: job?.steps ?? [], partial: job?.partial ?? {}, duration: job?.duration, mode: job?.mode };

  // Which pipeline the copy on this page is describing. Before a scan there is
  // no job, so the user's pill decides — and for `auto` the backend has already
  // told us which way it will resolve. Null only while that is genuinely
  // unknown, and the mode-neutral wording is used then.
  const activeMode: "cloud" | "sovereign" | null =
    job?.mode ?? (ingestMode === "sovereign" ? "sovereign" : modes.modeInfo?.resolved_auto ?? null);
  const sovereign = activeMode === "sovereign";
  const failureNote = segmentFailureNote(job?.partial ?? {});

  return (
    <AppFrame>
      {/* Same page rhythm as /playground: the route's top pad, then the
          console's own bottom breathing room. AppFrame owns the width. */}
      <div className="pb-24 pt-10">
        {/* The review screen's ONE audio element — stems, speaker samples and
            auditions all play through it. Never shown (this page draws its own
            play buttons per row), but it is a real element in the tree so the
            AudioBus can tap it and the shared transport can own it. */}
        <audio {...transport.audioProps} className="hidden" />
        <VoiceNewHeader sovereign={sovereign} activeMode={activeMode} />

        <VoiceNewNotices
          error={error}
          busy={busy}
          pending={pending}
          retryBusy={retryBusy}
          pollStalled={pollStalled}
          phase={phase}
          watching={watching}
          clipRefusal={clipRefusal}
        />

        {/* What THIS job is doing to the recording. Driven by job.mode, so a
            scan that `auto` RESOLVED to sovereign states its limits exactly as
            loudly as one where the pill was pressed — the resolved case used to
            state nothing at all. Shown from the moment analyze finishes (that
            is when the backend has them) through the review ledger. */}
        {job?.mode === "sovereign" && SCAN_PHASES.has(phase) && (
          <div className="mt-8 space-y-3">
            {(job.limits?.length ?? 0) > 0 && (
              <SovereignLimits limits={job.limits!} heading="sovereign mode · what this scan cannot do" />
            )}
            {job.detection && <DetectionFinding detection={job.detection} note={job.note} />}
          </div>
        )}

        {/* UPLOAD */}
        {phase === "upload" && (
          <VoiceNewUploadStage
            srcTab={srcTab}
            setSrcTab={setSrcTab}
            link={link}
            setLink={setLink}
            linkProbe={linkProbe}
            linkUsable={linkUsable}
            file={file}
            dragging={dragging}
            setDragging={setDragging}
            fileRef={fileRef}
            acceptFile={acceptFile}
            ingestMode={ingestMode}
            setIngestMode={setIngestMode}
            modes={modes}
            roster={roster}
            mode={mode}
            extendCid={extendCid}
            pending={pending}
            dispatch={dispatch}
            startScan={startScan}
            startLinkScan={startLinkScan}
          />
        )}

        {/* PROCESSING — Waveform Lab won the loader round */}
        {phase === "processing" && (
          <div className="mt-8">
            {job?.mode === "sovereign" && (
              <p className="font-jetbrains mb-3 inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/5 px-3 py-1 text-[11px] text-emerald-200">
                🔒 sovereign mode — processing locally, audio stays on this machine
              </p>
            )}
            <WaveformLab data={loaderData} />
          </div>
        )}

        {/* SPEAKER PICK — the casting board */}
        {phase === "speaker" && job?.speakers && (
          <VoiceNewSpeakerStage
            job={job}
            jobId={jobId}
            speakers={job.speakers}
            castSel={castSel}
            setCastSel={setCastSel}
            dispatch={dispatch}
            playClip={playClip}
            playing={playing}
            chooseSpeaker={chooseSpeaker}
            pending={pending}
            consented={consented}
            setConsented={setConsented}
            consentStatement={consentStatement}
            externalSource={externalSource}
            startCast={startCast}
          />
        )}

        {/* CASTING — per-CHARACTER progress, because one can fail alone */}
        {phase === "casting" && (
          <VoiceNewCastingStage
            job={job}
            cancelFailed={cancelFailed}
            cancelCommit={cancelCommit}
          />
        )}

        {/* REVIEW — ledger */}
        {phase === "review" && result && (
          <VoiceNewReviewStage
            state={state}
            result={result}
            dispatch={dispatch}
            failureNote={failureNote}
            takes={takes}
            requestTake={requestTake}
            playClip={playClip}
            playing={playing}
            auditionFor={auditionFor}
            setAuditionFor={setAuditionFor}
            boardFor={boardFor}
            setBoardFor={setBoardFor}
            casting={casting}
            castSegments={castSegments}
            roster={roster}
            consented={consented}
            setConsented={setConsented}
            keepCorpus={keepCorpus}
            setKeepCorpus={setKeepCorpus}
            externalSource={externalSource}
            pending={pending}
            commit={commit}
            startOver={startOver}
          />
        )}

        {/* COMMITTING — real per-emotion progress from the async commit */}
        {phase === "committing" && (
          <VoiceNewCommittingStage
            job={job}
            selected={selected}
            cancelFailed={cancelFailed}
            cancelCommit={cancelCommit}
            startOver={startOver}
          />
        )}

        {/* EXPIRED — the job aged out (or was cancelled); poller stopped */}
        {phase === "expired" && <VoiceNewExpiredStage startOver={startOver} />}

        {/* COMPLETE — a CAST. Per character, because the outcome is per
            character: some of them can exist while others do not. */}
        {phase === "complete" && job?.cast && (
          <VoiceNewCastComplete
            cast={job.cast}
            jobId={jobId}
            vaultWarn={vaultWarn}
            startOver={startOver}
          />
        )}

        {/* COMPLETE — a single-speaker commit */}
        {phase === "complete" && !job?.cast && (
          <VoiceNewCommitComplete
            job={job}
            result={result}
            created={created}
            committedCid={committedCid}
            fromCid={roster.fromCid}
            pendingCommit={state.pendingCommit}
            vaultWarn={vaultWarn}
            scanAnother={scanAnother}
          />
        )}
      </div>
    </AppFrame>
  );
}
