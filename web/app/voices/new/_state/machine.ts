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

import type { Detection, LoaderStep, Partial as PartialData } from "../_loaders/shared";

export type Speaker = { id: string; utterances: number; seconds: number; sample_text: string };
// `note` is the backend's statement about a stem that is not what its label
// implies — today: a baseline stem topped up with non-neutral segments because
// the recording had too little neutral speech. It must be SHOWN, never dropped:
// the whole point is that an emotionally blended baseline is never presented as
// a clean one (service/ingest.py::plan_baseline).
// One candidate splice of an emotion's segments, computed by the backend from
// the labels the scan already produced (service/ingest_api.py::build_recipes).
// `label`/`how` are the backend's own words for what makes this take different —
// the UI never invents a description of audio it did not measure. `default` marks
// the splice the ledger row is already reporting, which is what commits when
// nobody auditions anything.
export type Recipe = {
  id: string; label: string; how: string;
  seconds: number; segments: number; default?: boolean;
};
// `recipes` is optional and absent whenever there is no real choice (a single
// segment, or every candidate splice identical). Absent = the drill-down simply
// does not exist for that row — never an empty "no alternatives" affordance.
export type Stem = { emotion: string; seconds: number; segments: number; eligible: boolean; cues: string[]; note?: string | null; recipes?: Recipe[] };
// `min_stem` is the seconds-of-audio floor a stem must clear to be cloneable
// (service/ingest.py::MIN_STEM_SECONDS, echoed back per job) and `mode` is the
// pipeline that produced this ledger. Both are served on every result and both
// were dropped on the floor: the review screen spoke of "the clone threshold"
// without ever naming it, and reported a speaker COUNT in a mode that cannot
// count speakers.
export type Result = { duration: number; speakers: string[]; target: string; utterances: number; stems: Stem[]; min_stem: number; mode?: "cloud" | "sovereign" };
export type Character = { character_id: string; name: string };
export type Created = { voice_id: string; emotion: string };

export type Job = {
  status: string; step: string | null; steps: LoaderStep[]; partial: PartialData;
  speakers: Speaker[] | null; duration: number; result: Result | null; error: string | null;
  mode?: "cloud" | "sovereign"; committed?: Created[] | null;
  // What the analyze phase learned about THIS recording, served from the job
  // once analyze finishes (sovereign only, today; null in cloud mode):
  //   note      — the backend's sentence about the detection outcome
  //   limits    — SOVEREIGN_LIMITS as the backend holds them, so the studio
  //               states them instead of keeping its own copy
  //   detection — the outcome plus the levels it was decided on
  note?: string | null;
  limits?: string[] | null;
  detection?: Detection | null;
  // What the backend DID with the recipe choices at commit, plus why candidate
  // takes are absent when they are. `skipped` is the honesty half: a pick that
  // could not be applied is stated, never quietly downgraded to the default.
  recipes?: RecipeOutcome | null;
};

export type RecipeOutcome = {
  applied: Record<string, string>;
  skipped: { emotion: string; recipe: string; why: string }[];
  unavailable?: string | null;
};

/** GET /api/ingest/modes — the backend's own description of each ingest mode. */
export type ModeInfo = {
  resolved_auto: "cloud" | "sovereign";
  sovereign: { limits: string[]; note: string };
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
  // Audition Room: {emotion -> recipe id} the user's EAR chose. Empty is the
  // normal case — auditioning is an opt-in drill-down, and an emotion missing
  // from here commits the default splice the ledger already showed.
  auditions: Record<string, string>;
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
  auditions: {},
};

export type Action =
  | { type: "SET_ERROR"; error: string | null }
  | { type: "SCAN_STARTED"; jobId: string }
  | { type: "JOB_POLLED"; job: Job }
  | { type: "JOB_EXPIRED" }
  | { type: "SPEAKER_CHOSEN" }
  | { type: "COMMIT_STARTED"; character: string; cid: string; total: number }
  // `error: null` is the backpressure case: the commit was refused before any
  // cloning started, so the review ledger is returned to WITHOUT a failure
  // message — the page states the recoverable truth separately (amber).
  | { type: "COMMIT_FAILED"; error: string | null }
  | { type: "TOGGLE_EMOTION"; emotion: string }
  // The winner of an audition. `recipeId: null` returns the emotion to the
  // default splice — a vote must be undoable, or the drill-down becomes a trap.
  | { type: "CHOOSE_RECIPE"; emotion: string; recipeId: string | null }
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
        selected: new Set(), auditions: {}, error: null, phase: "processing" };

    case "JOB_POLLED": {
      const job = action.job;
      if (job.status === "error") {
        // A failure mid-commit still has an intact review ledger to return to;
        // a failure during analyze has nothing, so land back on upload.
        const backTo: Phase = state.phase === "committing" ? "review" : "upload";
        const error = job.error ?? (backTo === "review" ? "commit failed" : "failed");
        // Landing on upload used to keep `result`, `jobId` and the failed job:
        // a dead ledger for a recording the server has already discarded, still
        // readable by anything that asks (the Coverage Coach reads
        // `result?.stems`) and a jobId whose previews 404. An error clears the
        // state it invalidated; the ledger survives ONLY where it is still real.
        if (backTo === "upload") {
          return { ...state, phase: "upload", error,
            job: null, jobId: null, result: null, selected: new Set(),
            // The recipes were candidates OF that discarded recording; keeping
            // them would send a dead emotion→recipe map with the next commit.
            auditions: {},
            pendingCommit: null };
        }
        return { ...state, job, phase: "review", error };
      }
      const phase = statusToPhase(job);
      if (!phase) return { ...state, job };
      const next: State = { ...state, job, phase };
      if (job.status === "done" && job.result) {
        next.result = job.result;
        next.selected = new Set(job.result.stems.filter((s) => s.eligible).map((s) => s.emotion));
        // A fresh ledger is a fresh set of candidates; a recipe id chosen for a
        // previous scan means nothing here.
        next.auditions = {};
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

    case "CHOOSE_RECIPE": {
      const auditions = { ...state.auditions };
      if (action.recipeId === null) delete auditions[action.emotion];
      else auditions[action.emotion] = action.recipeId;
      return { ...state, auditions };
    }

    case "SET_MODE":
      return { ...state, mode: action.mode };
    case "SET_CHAR_NAME":
      return { ...state, charName: action.name };
    case "SET_EXTEND_CID":
      return { ...state, extendCid: action.cid };

    case "RESET": {
      // ONE reset, and it is a REAL one. start-over returns the flow to the
      // state it boots in — nothing of the previous recording, and nothing of
      // the previous COMMIT either: `committedCid` used to survive it, so a
      // brand-new flow could say "extending an existing character" about a
      // character the user had walked away from.
      //
      // scan-another is the one continuation: it deliberately carries the
      // just-committed character forward, pre-arming "add more emotions to it".
      if (action.kind === "scan-another") {
        return {
          ...initialState,
          selected: new Set(),
          auditions: {},
          mode: "extend",
          extendCid: state.committedCid ?? state.extendCid,
          committedCid: state.committedCid,
        };
      }
      return { ...initialState, selected: new Set(), auditions: {} };
    }

    default:
      return state;
  }
}
