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
// `identity` is the number the pipeline measures on the WRITTEN stem — how much
// the spliced audio still sounds like the speaker it was cut from
// (service/ingest.py::score_stems, "the number the review screen shows per
// stem"). It has always been served and the review screen never showed it.
//
// Absent is a real and correct state, in two different ways, and neither is an
// error: this backend may not measure identity at all, and — the load-bearing
// one — the service POPS the key the moment a stem is re-cast, because the
// score described the splice the user has just replaced. A stale number is the
// one thing that must never appear here.
export type Stem = { emotion: string; seconds: number; segments: number; eligible: boolean; cues: string[]; note?: string | null; recipes?: Recipe[]; identity?: number };
// `min_stem` is the seconds-of-audio floor a stem must clear to be cloneable
// (service/ingest.py::MIN_STEM_SECONDS, echoed back per job) and `mode` is the
// pipeline that produced this ledger. Both are served on every result and both
// were dropped on the floor: the review screen spoke of "the clone threshold"
// without ever naming it, and reported a speaker COUNT in a mode that cannot
// count speakers.
// One labelled span of the recording — the ATOM a stem is spliced from, and
// until the Casting Board the only thing on this screen the user could not see.
// `i` is the segment's own index (the id `/api/ingest/{job}/segment/{i}` serves),
// `ok` is whether it has audio at all, and `outlier` is the pipeline's own
// verdict: "dropped" = its audio is in no stem, "flagged" = it is, and it looked
// unlike the rest. Absent must render as nothing, never as a zero.
export type Segment = {
  i: number; emotion: string; confidence: number; cue: string; dur: number;
  text: string; model?: string; ok?: boolean;
  failure?: string | null; outlier?: string | null; escalation?: string | null;
};
export type Result = {
  duration: number; speakers: string[]; target: string; utterances: number;
  stems: Stem[]; min_stem: number; mode?: "cloud" | "sovereign"; segments?: Segment[];
  // The scan's fidelity payload. Only two fields are read here: whether
  // anything was measurable at all, and the service's OWN sentence about what
  // the number means — quoted on hover rather than paraphrased, because a
  // similarity score explained in the studio's words is a score the studio has
  // started defining.
  fidelity?: { available?: boolean; measures?: string | null } | null;
};
// What POST /api/ingest/{job}/stems answers with: every stem re-measured from
// the file it just wrote. `assigned` is what this stem is now spliced from,
// `proposed` what the pipeline chose, `takes` whether alternative recipes still
// exist for it (an edit withdraws them, because they described a selection the
// user has just replaced).
export type CastStem = {
  emotion: string; seconds: number; segments: number; eligible: boolean;
  note?: string | null; assigned: number[]; proposed: number[];
  edited: boolean; takes: boolean;
};
export type CastResult = {
  min_stem: number; reset: boolean; edited: string[]; changed: string[];
  stems: CastStem[];
};
export type Character = { character_id: string; name: string };
/**
 * One Voice the commit actually created (service/ingest.py::commit).
 *
 * The three fields past `emotion` were all measured, all served, and all
 * dropped by this studio:
 *   `identity`        — the clone is SYNTHESIZED and scored against the
 *                       speaker's own reference, so this is the finished
 *                       voice's own number, not the stem's.
 *   `identity_reason` — why there is no number. Named, never silent: "not
 *                       measured because …" and an empty slot are different
 *                       facts, and exactly one of the two is ever present.
 *   `replaced`        — the voice id this one UPGRADED out of the slot. An
 *                       extend-mode commit that overwrites an existing voice
 *                       said nothing at all about it.
 */
export type Created = {
  voice_id: string; emotion: string; seconds?: number;
  identity?: number; identity_reason?: string; replaced?: string;
};

export type Job = {
  status: string; step: string | null; steps: LoaderStep[]; partial: PartialData;
  speakers: Speaker[] | null; duration: number; result: Result | null; error: string | null;
  mode?: "cloud" | "sovereign"; committed?: Created[] | null;
  // What the analyze phase learned about THIS recording, served from the job
  // once analyze finishes (sovereign only, today; null in cloud mode):
  //   note      — the backend's sentence about the detection outcome
  //   limits    — sovereign_limits() as the backend derives them, so the studio
  //               states them instead of keeping its own copy
  //   detection — the outcome plus the levels it was decided on
  note?: string | null;
  limits?: string[] | null;
  detection?: Detection | null;
  // What the backend DID with the recipe choices at commit, plus why candidate
  // takes are absent when they are. `skipped` is the honesty half: a pick that
  // could not be applied is stated, never quietly downgraded to the default.
  recipes?: RecipeOutcome | null;
  // The Casting Board's server-side state: what each stem is currently spliced
  // from, and which emotions the user has re-cast. Served on every poll so a
  // reload never shows a ledger whose numbers disagree with the audio.
  casting?: { assignments: Record<string, number[]>; edited: string[] } | null;
  // Whether this recording's audio was KEPT on the box for the character, and —
  // always — why not. Optional here only because an older service would not
  // send it; when it is present the complete screen states it.
  corpus?: CorpusOutcome | null;
};

/**
 * What this box did with the recording's audio once the clone succeeded — the
 * job's `corpus` key (service/ingest_api.py, `_PUBLIC_KEYS`).
 *
 * It is served on EVERY job and it always names the outcome, including "not
 * requested" — a silent absence would be indistinguishable from a capture that
 * failed, which on a retention surface is the one confusion that matters. So
 * `requested` and `captured` are required here and `reason` is the sentence to
 * print whenever `captured` is false.
 */
export type CorpusOutcome = {
  requested: boolean;
  captured: boolean;
  reason?: string | null;
  /** The recording was already in the corpus (content-addressed by clip hash). */
  already?: boolean;
  clip_sha256?: string | null;
  rev?: number;
  /** Segments whose AUDIO was copied, out of the labels recorded. */
  segments?: number;
  segments_recorded?: number;
  stems?: number;
  bytes?: number;
  /** Clips evicted to stay under the byte cap, each with the service's own why. */
  pruned?: { clip_sha256: string; bytes?: number | null; why: string }[];
  /** Set on a re-derivation job: it READS the corpus at this revision. */
  corpus_rev?: number;
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

// Phases where NOTHING is progressing server-side — but the job can still die
// under the user, so it is watched at a slow cadence.
//
// The service ages a job from its last state MUTATION, not from the last read:
// `touched` is written only by `_persist` (ingest_api.py), and `get_job` does a
// bare `JOBS.get` under the lock without persisting anything. So a GET neither
// keeps a job alive nor defeats GC — which is exactly what makes watching
// review safe: a user reading the ledger for the full 30-minute idle TTL had a
// dead job under a live-looking screen, and the first they heard of it was a
// commit that 404'd into COMMIT_FAILED, on a screen with no way out.
export const WATCH_PHASES: ReadonlySet<Phase> = new Set<Phase>(["review"]);

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
  // Casting Board: {emotion -> segment indices} this stem is spliced from.
  // Empty is the normal case and means "whatever the pipeline proposed" — the
  // board fills it in from the server's answer the first time anything is
  // re-cast, so an empty map and a map that happens to equal the proposal stay
  // distinguishable.
  assignments: Record<string, number[]>;
  // Emotions whose stem is no longer the pipeline's own splice. Drives the
  // "edited" marks; "reset to proposed" is offered whether or not it is empty.
  dirty: string[];
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
  assignments: {},
  dirty: [],
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
  // Casting Board. CAST_SEGMENTS is the OPTIMISTIC half — the checkbox has to
  // answer the click, and the re-splice behind it is debounced. CAST_SYNCED is
  // the server's answer, and it is the only thing that ever moves the seconds,
  // the eligible badge or the note: those are measurements of a file, and the
  // browser is not allowed to guess them.
  | { type: "CAST_SEGMENTS"; assignments: Record<string, number[]> }
  | { type: "CAST_SYNCED"; cast: CastResult }
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
        selected: new Set(), auditions: {}, assignments: {}, dirty: [],
        error: null, phase: "processing" };

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
            // Same for a segment selection: those indices addressed segments in
            // a workdir the server has already torn down.
            assignments: {}, dirty: [],
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
        // previous scan means nothing here, and neither does a segment index.
        next.auditions = {};
        // What each stem is spliced FROM, as the backend published it with the
        // ledger. Derived server-side on purpose: a borrowed baseline is not
        // "the neutral segments", so a map built here from the labels would
        // describe a stem the pipeline never built.
        next.assignments = job.casting?.assignments ?? {};
        next.dirty = job.casting?.edited ?? [];
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

    case "CAST_SEGMENTS":
      return { ...state, assignments: { ...state.assignments, ...action.assignments } };

    case "CAST_SYNCED": {
      if (!state.result) return state;
      const by = new Map(action.cast.stems.map((s) => [s.emotion, s]));
      // The stems the service actually RE-SPLICED. It pops each one's identity
      // score server-side (the number described the previous splice), and the
      // re-splice answer carries no identity at all — so a client that merged
      // the answer over the old row would keep showing a measurement of audio
      // that no longer exists. Absent is the honest state; a stale number is not.
      const changed = new Set(action.cast.changed);
      const stems = state.result.stems.map((st) => {
        const c = by.get(st.emotion);
        if (!c) return st;
        const next: Stem = { ...st, seconds: c.seconds, segments: c.segments,
          eligible: c.eligible, note: c.note ?? null };
        if (changed.has(c.emotion)) delete next.identity;
        // The alternative takes were readings of the splice the pipeline
        // proposed. Once a row is re-cast the backend withdraws them, and an
        // offer it would refuse at commit must leave the screen with it.
        if (!c.takes) delete next.recipes;
        return next;
      });
      const assignments = { ...state.assignments };
      const auditions = { ...state.auditions };
      const selected = new Set(state.selected);
      for (const c of action.cast.stems) {
        assignments[c.emotion] = c.assigned;
        if (!c.takes) delete auditions[c.emotion];
        // A stem the user cast below the clone minimum is descoped rather than
        // left ticked for a commit the backend will refuse. Crossing the line
        // the other way is NOT auto-ticked: keeping is the user's click, and
        // silently re-adding a row they descoped would undo their decision.
        if (!c.eligible) selected.delete(c.emotion);
      }
      return { ...state, result: { ...state.result, stems },
        assignments, auditions, selected, dirty: action.cast.edited };
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
          assignments: {},
          dirty: [],
          mode: "extend",
          extendCid: state.committedCid ?? state.extendCid,
          committedCid: state.committedCid,
        };
      }
      return { ...initialState, selected: new Set(), auditions: {},
        assignments: {}, dirty: [] };
    }

    default:
      return state;
  }
}
