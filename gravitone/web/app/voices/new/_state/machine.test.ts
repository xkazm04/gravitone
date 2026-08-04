// Behaviour of the create-a-character flow's state machine.
//
// These pin what a USER can end up looking at — "after an analyze failure the
// screen offers no ledger", "a fresh flow claims no character" — not the shape
// of the reducer. A refactor that keeps those promises keeps these green.
import { describe, expect, it } from "vitest";
import {
  POLLING_PHASES, TERMINAL_STATUSES, initialState, reducer, statusToPhase,
  type Action, type Job, type Result, type State,
} from "./machine";

function job(over: Partial<Job> = {}): Job {
  return {
    status: "running", step: "isolate", steps: [], partial: {},
    speakers: null, duration: 0, result: null, error: null, ...over,
  };
}

function result(over: Partial<Result> = {}): Result {
  return {
    duration: 90, speakers: ["spk_0"], target: "spk_0", utterances: 12, min_stem: 8,
    stems: [
      { emotion: "neutral", seconds: 40, segments: 9, eligible: true, cues: [] },
      { emotion: "angry", seconds: 2, segments: 1, eligible: false, cues: [] },
    ],
    ...over,
  };
}

/** Drive the reducer over a script, the way the page does. */
function run(from: State, ...actions: Action[]): State {
  return actions.reduce(reducer, from);
}

const scanned = run(initialState, { type: "SCAN_STARTED", jobId: "j1" });

describe("statusToPhase", () => {
  it("maps every non-error status to the phase it means", () => {
    const cases: [string, string][] = [
      ["awaiting_speaker", "speaker"], ["running", "processing"], ["done", "review"],
      ["committing", "committing"], ["committed", "complete"],
      ["cancelled", "expired"], ["expired", "expired"],
    ];
    for (const [status, phase] of cases) {
      expect(statusToPhase(job({ status }))).toBe(phase);
    }
  });

  it("refuses to decide for an error — that depends on where it failed", () => {
    expect(statusToPhase(job({ status: "error" }))).toBeNull();
  });

  it("polls exactly the phases where the job is live server-side", () => {
    expect([...POLLING_PHASES].sort()).toEqual(["committing", "processing", "speaker"]);
    expect(POLLING_PHASES.has("review")).toBe(false);
    expect(POLLING_PHASES.has("complete")).toBe(false);
  });

  it("treats every finished status as terminal for polling", () => {
    for (const s of ["done", "committed", "error", "cancelled", "expired"]) {
      expect(TERMINAL_STATUSES.has(s)).toBe(true);
    }
    expect(TERMINAL_STATUSES.has("running")).toBe(false);
  });
});

describe("SCAN_STARTED", () => {
  it("moves to processing with no invented job and no stale ledger", () => {
    const dirty: State = { ...initialState, result: result(), error: "old", selected: new Set(["angry"]) };
    const s = reducer(dirty, { type: "SCAN_STARTED", jobId: "j9" });
    expect(s.phase).toBe("processing");
    expect(s.jobId).toBe("j9");
    expect(s.job).toBeNull();          // the loader shows the server's own steps
    expect(s.result).toBeNull();
    expect(s.selected.size).toBe(0);
    expect(s.error).toBeNull();
  });
});

describe("JOB_POLLED", () => {
  it("carries what was MEASURED about each created voice, and what it replaced", () => {
    // Post-commit the service reports a clone's own identity, a named reason
    // when it could not be measured, and the voice id an extend-mode commit
    // OVERWROTE. The complete screen used to render emotion names only, so a
    // commit that destroyed an existing embedding said nothing about it.
    const s = run(scanned,
      { type: "COMMIT_STARTED", character: "Sarah", cid: "sarah", total: 2 },
      { type: "JOB_POLLED", job: job({ status: "committed", committed: [
        { voice_id: "v1", emotion: "angry", seconds: 12, identity: 0.93 },
        { voice_id: "v2", emotion: "sad", identity_reason: "no reference audio", replaced: "v0" },
      ] }) });
    expect(s.created[0].identity).toBe(0.93);
    expect(s.created[1].identity).toBeUndefined();
    expect(s.created[1].identity_reason).toBe("no reference audio");
    expect(s.created[1].replaced).toBe("v0");
  });

  it("carries the retention outcome through to the screen that states it", () => {
    // The service names this on EVERY job, including "not requested" — a key
    // the reducer dropped would be indistinguishable from a capture that failed.
    const committed = run(scanned,
      { type: "COMMIT_STARTED", character: "Sarah", cid: "sarah", total: 1 },
      { type: "JOB_POLLED", job: job({
        status: "committed", committed: [{ voice_id: "v1", emotion: "angry" }],
        corpus: { requested: true, captured: true, segments: 9, stems: 2, bytes: 4096 },
      }) });
    expect(committed.phase).toBe("complete");
    expect(committed.job?.corpus).toEqual({
      requested: true, captured: true, segments: 9, stems: 2, bytes: 4096,
    });
  });

  it("follows the server through the analyze leg", () => {
    expect(reducer(scanned, { type: "JOB_POLLED", job: job({ status: "running" }) }).phase)
      .toBe("processing");
    expect(reducer(scanned, { type: "JOB_POLLED", job: job({ status: "awaiting_speaker" }) }).phase)
      .toBe("speaker");
  });

  it("adopts the ledger on done and pre-selects only the cloneable stems", () => {
    const s = reducer(scanned, { type: "JOB_POLLED", job: job({ status: "done", result: result() }) });
    expect(s.phase).toBe("review");
    expect(s.result?.utterances).toBe(12);
    expect([...s.selected]).toEqual(["neutral"]);   // "angry" is under min_stem
  });

  it("keeps the current phase for a status it does not recognise", () => {
    const s = reducer(scanned, { type: "JOB_POLLED", job: job({ status: "warming_up" }) });
    expect(s.phase).toBe("processing");
    expect(s.job?.status).toBe("warming_up");
  });

  it("records the committed voices and the character they landed on", () => {
    const at = run(initialState,
      { type: "SCAN_STARTED", jobId: "j1" },
      { type: "JOB_POLLED", job: job({ status: "done", result: result() }) },
      { type: "COMMIT_STARTED", character: "Ada", cid: "ada", total: 1 },
      { type: "JOB_POLLED", job: job({ status: "committed", committed: [{ voice_id: "v1", emotion: "neutral" }] }) });
    expect(at.phase).toBe("complete");
    expect(at.created).toEqual([{ voice_id: "v1", emotion: "neutral" }]);
    expect(at.committedCid).toBe("ada");
  });

  it("goes to expired when the server says the session is gone", () => {
    expect(reducer(scanned, { type: "JOB_POLLED", job: job({ status: "expired" }) }).phase)
      .toBe("expired");
    expect(reducer(scanned, { type: "JOB_POLLED", job: job({ status: "cancelled" }) }).phase)
      .toBe("expired");
  });

  describe("an error", () => {
    it("mid-commit returns to the review ledger it can still act on", () => {
      const at = run(initialState,
        { type: "SCAN_STARTED", jobId: "j1" },
        { type: "JOB_POLLED", job: job({ status: "done", result: result() }) },
        { type: "COMMIT_STARTED", character: "Ada", cid: "ada", total: 1 },
        { type: "JOB_POLLED", job: job({ status: "error", error: "clone died" }) });
      expect(at.phase).toBe("review");
      expect(at.error).toBe("clone died");
      expect(at.result).not.toBeNull();   // the ledger is still real
      expect(at.jobId).toBe("j1");        // previews still resolve
    });

    it("during analyze leaves NO ledger behind on the upload screen", () => {
      // The recording is discarded server-side; anything reading `result`
      // (the Coverage Coach reads result?.stems) or hitting /ingest/{jobId}
      // would be reading a job that no longer exists.
      const at = run(initialState,
        { type: "SCAN_STARTED", jobId: "j1" },
        { type: "JOB_POLLED", job: job({ status: "done", result: result() }) },
        { type: "JOB_POLLED", job: job({ status: "error", error: "no speech found" }) });
      expect(at.phase).toBe("upload");
      expect(at.error).toBe("no speech found");
      expect(at.result).toBeNull();
      expect(at.jobId).toBeNull();
      expect(at.job).toBeNull();
      expect(at.selected.size).toBe(0);
      expect(at.pendingCommit).toBeNull();
    });

    it("still says something when the server names no reason", () => {
      expect(reducer(scanned, { type: "JOB_POLLED", job: job({ status: "error" }) }).error)
        .toBeTruthy();
    });
  });
});

describe("the rest of the transitions", () => {
  it("JOB_EXPIRED moves to the expired screen", () => {
    expect(reducer(scanned, { type: "JOB_EXPIRED" }).phase).toBe("expired");
  });

  it("SPEAKER_CHOSEN returns to the loader while the server catches up", () => {
    expect(reducer({ ...scanned, phase: "speaker" }, { type: "SPEAKER_CHOSEN" }).phase)
      .toBe("processing");
  });

  it("COMMIT_STARTED shows real progress out of the emotions being cloned", () => {
    const at = run(initialState,
      { type: "SCAN_STARTED", jobId: "j1" },
      { type: "JOB_POLLED", job: job({ status: "done", result: result() }) },
      { type: "COMMIT_STARTED", character: "Ada", cid: "ada", total: 3 });
    expect(at.phase).toBe("committing");
    expect(at.error).toBeNull();
    expect(at.pendingCommit).toEqual({ character: "Ada", cid: "ada" });
    expect(at.job?.partial).toEqual({ emotions_done: 0, emotions_total: 3, current: null });
  });

  it("COMMIT_FAILED returns to the ledger, with or without a message", () => {
    const failed = reducer({ ...scanned, phase: "committing" }, { type: "COMMIT_FAILED", error: "backend said no" });
    expect(failed.phase).toBe("review");
    expect(failed.error).toBe("backend said no");
    // Backpressure: refused before anything was cloned, so nothing failed.
    const refused = reducer({ ...scanned, phase: "committing", error: "stale" }, { type: "COMMIT_FAILED", error: null });
    expect(refused.phase).toBe("review");
    expect(refused.error).toBeNull();
  });

  it("TOGGLE_EMOTION adds and removes without mutating the previous selection", () => {
    const a = reducer({ ...scanned, selected: new Set(["neutral"]) }, { type: "TOGGLE_EMOTION", emotion: "angry" });
    expect([...a.selected].sort()).toEqual(["angry", "neutral"]);
    const b = reducer(a, { type: "TOGGLE_EMOTION", emotion: "angry" });
    expect([...b.selected]).toEqual(["neutral"]);
    expect([...a.selected].sort()).toEqual(["angry", "neutral"]); // untouched
  });

  it("carries the character identity fields", () => {
    let s = reducer(initialState, { type: "SET_MODE", mode: "extend" });
    s = reducer(s, { type: "SET_CHAR_NAME", name: "Ada" });
    s = reducer(s, { type: "SET_EXTEND_CID", cid: "vera" });
    expect([s.mode, s.charName, s.extendCid]).toEqual(["extend", "Ada", "vera"]);
  });

  it("SET_ERROR both raises and clears", () => {
    const raised = reducer(initialState, { type: "SET_ERROR", error: "bad file" });
    expect(raised.error).toBe("bad file");
    expect(reducer(raised, { type: "SET_ERROR", error: null }).error).toBeNull();
  });

  it("CHOOSE_RECIPE records the take the ear picked, and undoes it", () => {
    const picked = reducer(initialState, { type: "CHOOSE_RECIPE", emotion: "angry", recipeId: "longest" });
    expect(picked.auditions).toEqual({ angry: "longest" });
    // null = "back to the default splice", not "remember an empty choice".
    const undone = reducer(picked, { type: "CHOOSE_RECIPE", emotion: "angry", recipeId: null });
    expect(undone.auditions).toEqual({});
    // Auditioning one emotion never touches another.
    const two = reducer(picked, { type: "CHOOSE_RECIPE", emotion: "sad", recipeId: "tightest" });
    expect(two.auditions).toEqual({ angry: "longest", sad: "tightest" });
  });

  it("a fresh ledger discards takes chosen for the previous scan", () => {
    const picked = reducer(scanned, { type: "CHOOSE_RECIPE", emotion: "angry", recipeId: "longest" });
    const polled = reducer(picked, { type: "JOB_POLLED", job: job({ status: "done", result: result() }) });
    expect(polled.auditions).toEqual({});
  });

  it("an analyze failure drops the takes along with the ledger it discarded", () => {
    const picked = reducer(scanned, { type: "CHOOSE_RECIPE", emotion: "angry", recipeId: "longest" });
    const failed = reducer(picked, { type: "JOB_POLLED", job: job({ status: "error", error: "nope" }) });
    expect(failed.phase).toBe("upload");
    expect(failed.auditions).toEqual({});
  });

  it("ignores an action it does not know", () => {
    const s = reducer(scanned, { type: "NOPE" } as unknown as Action);
    expect(s).toBe(scanned);
  });
});

describe("RESET", () => {
  const committed = run(initialState,
    { type: "SCAN_STARTED", jobId: "j1" },
    { type: "JOB_POLLED", job: job({ status: "done", result: result() }) },
    { type: "SET_CHAR_NAME", name: "Ada" },
    { type: "COMMIT_STARTED", character: "Ada", cid: "ada", total: 1 },
    { type: "JOB_POLLED", job: job({ status: "committed", committed: [{ voice_id: "v1", emotion: "neutral" }] }) });

  it("start-over leaves a flow that claims nothing about a previous character", () => {
    const s = reducer(committed, { type: "RESET", kind: "start-over" });
    expect(s.phase).toBe("upload");
    expect(s.committedCid).toBeNull();   // the extend line has nothing to render from
    expect(s.mode).toBe("new");
    expect(s.extendCid).toBe("");
    expect(s.charName).toBe("");
    expect(s.jobId).toBeNull();
    expect(s.job).toBeNull();
    expect(s.result).toBeNull();
    expect(s.created).toEqual([]);
    expect(s.selected.size).toBe(0);
    expect(s.error).toBeNull();
    expect(s.pendingCommit).toBeNull();
  });

  it("scan-another clears the recording but keeps the character it will extend", () => {
    const s = reducer(committed, { type: "RESET", kind: "scan-another" });
    expect(s.phase).toBe("upload");
    expect(s.mode).toBe("extend");
    expect(s.extendCid).toBe("ada");
    expect(s.jobId).toBeNull();
    expect(s.result).toBeNull();
    expect(s.created).toEqual([]);
    expect(s.selected.size).toBe(0);
  });

  it("scan-another with nothing committed falls back to whatever was chosen", () => {
    const s = reducer({ ...initialState, extendCid: "vera" }, { type: "RESET", kind: "scan-another" });
    expect(s.extendCid).toBe("vera");
  });

  it("start-over and scan-another both forget the takes the ear chose", () => {
    const picked = reducer(committed, { type: "CHOOSE_RECIPE", emotion: "angry", recipeId: "longest" });
    expect(reducer(picked, { type: "RESET", kind: "start-over" }).auditions).toEqual({});
    expect(reducer(picked, { type: "RESET", kind: "scan-another" }).auditions).toEqual({});
  });

  it("does not hand out a shared selection set between resets", () => {
    const a = reducer(committed, { type: "RESET", kind: "start-over" });
    const b = reducer(committed, { type: "RESET", kind: "start-over" });
    expect(a.selected).not.toBe(b.selected);
    expect(a.selected).not.toBe(initialState.selected);
  });
});
