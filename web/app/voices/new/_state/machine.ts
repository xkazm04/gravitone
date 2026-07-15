// State machine for the create-a-character-from-a-recording flow.
//
// Everything the flow's correctness depends on lives in ONE state object:
// phase + job + selection + the character-identity fields. A single reducer
// owns every legal transition, and ONE pure statusToPhase() maps a server job
// status to a UI phase — used by the single polling hook for both the analyze
// leg and the commit leg (no more two hand-rolled pollers that drift).
//
// Ephemeral input/UI state (the chosen File, drag hover, consent checkbox,
// privacy mode, which clip is playing, the cloned-character list) stays as
// plain useState in the page — it isn't part of the flow's state graph.

import type { LoaderStep, Partial as PartialData } from "../_loaders/shared";

export type Speaker = { id: string; utterances: number; seconds: number; sample_text: string };
export type Stem = { emotion: string; seconds: number; segments: number; eligible: boolean; cues: string[] };
export type Result = { duration: number; speakers: string[]; target: string; utterances: number; stems: Stem[] };
export type Character = { character_id: string; name: string };
export type Created = { voice_id: string; emotion: string };

export type Job = {
  status: string; step: string | null; steps: LoaderStep[]; partial: PartialData;
  speakers: Speaker[] | null; duration: number; result: Result | null; error: string | null;
  mode?: "cloud" | "sovereign"; committed?: Created[] | null;
};

export type Phase =
  | "upload" | "processing" | "speaker" | "review"
  | "committing" | "complete" | "expired";

// Phases where the job is live server-side and must be polled.
export const POLLING_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  "processing", "speaker", "committing",
]);

// Server statuses that are terminal for polling — the hook stops on these.
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "done", "committed", "error", "cancelled", "expired",
]);

/**
 * The ONE status→phase mapping. Pure and total for every non-error status.
 * Returns null for "error", because the phase to land on after a failure
 * depends on *where* it failed (mid-commit → back to the review ledger;
 * otherwise → back to upload) — the reducer resolves that from context.
 */
export function statusToPhase(job: Job): Phase | null {
  switch (job.status) {
    case "awaiting_speaker": return "speaker";
    case "running": return "processing";
    case "done": return "review";
    case "committing": return "committing";
    case "committed": return "complete";
    case "cancelled":
    case "expired": return "expired";
    default: return null; // "error" — reducer decides relative to current phase
  }
}

export type State = {
  phase: Phase;
  jobId: string | null;
  job: Job | null;
  result: Result | null;
  selected: Set<string>;
  error: string | null;
  // character identity (one home for the three formerly-overlapping ids)
  mode: "new" | "extend";
  charName: string;
  extendCid: string;
  committedCid: string | null;
  pendingCommit: { character: string; cid: string } | null;
  created: Created[];
};

export const initialState: State = {
  phase: "upload",
  jobId: null,
  job: null,
  result: null,
  selected: new Set(),
  error: null,
  mode: "new",
  charName: "",
  extendCid: "",
  committedCid: null,
  pendingCommit: null,
  created: [],
};

export type Action =
  | { type: "SET_ERROR"; error: string | null }
  | { type: "SCAN_STARTED"; jobId: string }
  | { type: "JOB_POLLED"; job: Job }
  | { type: "JOB_EXPIRED" }
  | { type: "SPEAKER_CHOSEN" }
  | { type: "COMMIT_STARTED"; character: string; cid: string; total: number }
  | { type: "COMMIT_FAILED"; error: string }
  | { type: "TOGGLE_EMOTION"; emotion: string }
  | { type: "SET_MODE"; mode: "new" | "extend" }
  | { type: "SET_CHAR_NAME"; name: string }
  | { type: "SET_EXTEND_CID"; cid: string }
  | { type: "RESET"; kind: "start-over" | "scan-another" };

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "SET_ERROR":
      return { ...state, error: action.error };

    case "SCAN_STARTED":
      // No fabricated step labels: job stays null until the first poll brings
      // the server's own steps (~1.5s). The loader shows a neutral placeholder.
      return { ...state, jobId: action.jobId, job: null, result: null,
        selected: new Set(), error: null, phase: "processing" };

    case "JOB_POLLED": {
      const job = action.job;
      if (job.status === "error") {
        // A failure mid-commit still has an intact review ledger to return to;
        // a failure during analyze has nothing, so land back on upload.
        const backTo: Phase = state.phase === "committing" ? "review" : "upload";
        return { ...state, job, phase: backTo,
          error: job.error ?? (backTo === "review" ? "commit failed" : "failed") };
      }
      const phase = statusToPhase(job);
      if (!phase) return { ...state, job };
      const next: State = { ...state, job, phase };
      if (job.status === "done" && job.result) {
        next.result = job.result;
        next.selected = new Set(job.result.stems.filter((s) => s.eligible).map((s) => s.emotion));
      }
      if (job.status === "committed") {
        next.created = job.committed ?? [];
        next.committedCid = state.pendingCommit?.cid ?? state.committedCid;
      }
      return next;
    }

    case "JOB_EXPIRED":
      return { ...state, phase: "expired" };

    case "SPEAKER_CHOSEN":
      // Optimistic: the backend flips to running and clears partial; the next
      // poll refreshes the loader from the server.
      return { ...state, phase: "processing" };

    case "COMMIT_STARTED":
      return { ...state, phase: "committing", error: null,
        pendingCommit: { character: action.character, cid: action.cid },
        job: state.job
          ? { ...state.job, status: "committing",
              partial: { emotions_done: 0, emotions_total: action.total, current: null } }
          : state.job };

    case "COMMIT_FAILED":
      return { ...state, phase: "review", error: action.error };

    case "TOGGLE_EMOTION": {
      const selected = new Set(state.selected);
      if (selected.has(action.emotion)) selected.delete(action.emotion);
      else selected.add(action.emotion);
      return { ...state, selected };
    }

    case "SET_MODE":
      return { ...state, mode: action.mode };
    case "SET_CHAR_NAME":
      return { ...state, charName: action.name };
    case "SET_EXTEND_CID":
      return { ...state, extendCid: action.cid };

    case "RESET": {
      // ONE reset. Both start-over and scan-another clear the job, ledger,
      // selection, error and pending commit identically. scan-another only
      // additionally pre-arms "extend the character we just built".
      const base: State = {
        ...state,
        jobId: null, job: null, result: null, created: [],
        selected: new Set(), error: null, pendingCommit: null,
        phase: "upload",
      };
      if (action.kind === "scan-another") {
        return { ...base, mode: "extend", extendCid: state.committedCid ?? state.extendCid };
      }
      return base;
    }

    default:
      return state;
  }
}
