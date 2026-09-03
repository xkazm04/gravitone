"use client";

import type { Dispatch, RefObject } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button } from "@/components/ui/Primitives";
import type { Action, ModeInfo } from "../_state/machine";
import { ACCEPT_ATTR, LIMITS_HINT } from "../_state/uploadLimits";
import type { Pending } from "../_state/useIngestActions";
import type { useCloneRoster } from "../_state/useCloneRoster";
import type { ProbeState } from "../_state/useLinkProbe";
import VoiceNewLinkDoor from "./VoiceNewLinkDoor";
import VoiceNewModePanel from "./VoiceNewModePanel";

// Which door the recording comes through. The link tab is a second WAY IN and
// nothing more: it produces the same job id, so every screen after this one is
// untouched by it.
export type SourceTab = "file" | "link";

/** The first screen: two doors into the same scan, and what the scan will do. */
export default function VoiceNewUploadStage({
  srcTab, setSrcTab, link, setLink, linkProbe, linkUsable,
  file, dragging, setDragging, fileRef, acceptFile,
  ingestMode, setIngestMode, modes, roster, mode, extendCid,
  pending, dispatch, startScan, startLinkScan,
}: {
  srcTab: SourceTab;
  setSrcTab: (t: SourceTab) => void;
  link: string;
  setLink: (v: string) => void;
  linkProbe: ProbeState;
  linkUsable: boolean;
  file: File | null;
  dragging: boolean;
  setDragging: (v: boolean) => void;
  fileRef: RefObject<HTMLInputElement | null>;
  acceptFile: (f: File | undefined | null) => void;
  ingestMode: "auto" | "sovereign";
  setIngestMode: (m: "auto" | "sovereign") => void;
  modes: { modeInfo: ModeInfo | null; modeInfoFailed: boolean };
  roster: ReturnType<typeof useCloneRoster>;
  mode: "new" | "extend";
  extendCid: string;
  pending: Pending;
  dispatch: Dispatch<Action>;
  startScan: () => void;
  startLinkScan: () => void;
}) {
  const { returningTo, fromUnknown, fromCid, rosterFailed, rosterLoaded } = roster;
  return (
    <div className="mt-8">
      {/* Two doors into the same flow. A tab rather than a second page:
          whichever one is used, what comes back is a job id and every
          screen after this is identical. */}
      <div role="tablist" aria-label="Where the recording comes from"
        className="mb-4 flex gap-2">
        {([["file", "Drop a file"], ["link", "Paste a link"]] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={srcTab === id}
            onClick={() => { setSrcTab(id); dispatch({ type: "SET_ERROR", error: null }); }}
            className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] transition ${srcTab === id ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60 hover:text-white"}`}>
            {label}
          </button>
        ))}
      </div>

      {srcTab === "link" && (
        <VoiceNewLinkDoor
          link={link}
          setLink={setLink}
          linkProbe={linkProbe}
          linkUsable={linkUsable}
          pending={pending}
          dispatch={dispatch}
          startLinkScan={startLinkScan}
        />
      )}

      {srcTab === "file" && (
      <div
        role="button" tabIndex={0} aria-label="Choose or drop an audio recording"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void acceptFile(e.dataTransfer.files?.[0]); }}
        onClick={() => fileRef.current?.click()}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } }}
        className={`grid cursor-pointer place-items-center rounded-2xl border-2 border-dashed px-6 py-14 text-center transition focus:outline-none focus-visible:border-cyan-400/60 focus-visible:bg-cyan-400/5 ${dragging ? "border-cyan-400/60 bg-cyan-400/5" : "border-white/12 hover:border-white/30"}`}
      >
        <input ref={fileRef} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => { void acceptFile(e.target.files?.[0]); }} />
        <div>
          <div className="text-lg text-white">{file ? file.name : "Drop an mp3 / recording, or click to choose"}</div>
          <div className="font-jetbrains mt-1 text-[12px] text-white/55">
            {file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "a minute+ of speech with emotional range works best"}
          </div>
          {/* The caps, printed from the same constants the pre-check
              uses — a user should learn the ceiling before the upload. */}
          <div className="font-jetbrains mt-1 text-[11px] text-white/35">{LIMITS_HINT}</div>
        </div>
      </div>
      )}
      {/* Driven by what this flow will actually DO (extend mode, armed
          with a character) rather than by "a commit happened once" —
          which RESET used to leave behind for a brand-new flow to read. */}
      {mode === "extend" && extendCid && (
        <p className="font-jetbrains mt-3 text-[12px] text-cyan-300/80">
          {returningTo
            ? `Extending ${returningTo} — the voices you commit attach to it, and you land back on its page.`
            : "Extending an existing character with more emotions."}
        </p>
      )}
      {/* The inbound link named a character this roster does not have.
          Rose: the thing the link asked for did not happen. Nothing is
          pre-armed, so say which character and what the flow will do
          instead — a silent fallback to "New character" would quietly
          create a duplicate. */}
      {fromUnknown && (
        <ErrorBanner>
          “{fromUnknown}” is not one of your cloned characters, so nothing was
          pre-selected — this scan will create a NEW character unless you pick one
          to extend below.
        </ErrorBanner>
      )}
      {fromCid && rosterFailed && !rosterLoaded && (
        <ErrorBanner severity="warning">
          Your characters could not be loaded, so the character you came from could not
          be pre-selected. Reload to retry — nothing about your recording is affected.
        </ErrorBanner>
      )}

      {/* privacy mode */}
      <VoiceNewModePanel
        ingestMode={ingestMode}
        setIngestMode={setIngestMode}
        modes={modes}
      />

      {/* The kickoff uploads the whole file and is allowed 120s by the
          proxy — without a pending state the page looked inert. */}
      {srcTab === "file" ? (
        <Button onClick={startScan} disabled={!file || pending !== null} className="mt-5 cursor-pointer">
          {pending === "scan" ? "Uploading & starting…" : "Scan recording →"}
        </Button>
      ) : (
        // The fetch happens on the box and is allowed 240s by the proxy;
        // without a pending state the page would look inert for the whole
        // download.
        // The button states what it will DO — including that it will take
        // only the head of a long video — and it stays disabled until the
        // verdict is in, because "scan" on an unchecked link is exactly
        // the two-minute wait this direction removes.
        <Button onClick={startLinkScan} disabled={!linkUsable || pending !== null} className="mt-5 cursor-pointer">
          {pending === "scan"
            ? "Fetching audio…"
            : linkProbe.status === "done" && linkProbe.verdict.trimmed
              ? `Scan the first ${Math.round((linkProbe.verdict.clip_seconds ?? 0) / 60)} minutes →`
              : "Scan this link →"}
        </Button>
      )}
    </div>
  );
}
