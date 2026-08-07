// The Segment Casting Board: what a stem is built from, and what a click does.
//
// These pin what a USER ends up cloning — "the excluded segment is really out",
// "a segment the pipeline rejected can never be clicked back in", "the length on
// screen is always the one the service measured" — not the shape of the module.
import { describe, expect, it } from "vitest";
import {
  blockedReason, boardRows, castableElsewhere, identityMeasured, labelSource,
  moveSegment, shortBy, stemIdentity, stemProgress, toggleSegment, wouldEmpty,
} from "./casting";
import { initialState, reducer, type CastResult, type Job, type Result, type Segment, type Stem } from "./machine";

function seg(over: Partial<Segment> & { i: number }): Segment {
  return {
    emotion: "happy", confidence: 0.8, cue: "", dur: 2, text: "", ok: true,
    failure: null, outlier: null, ...over,
  };
}

const SEGMENTS: Segment[] = [
  seg({ i: 0, emotion: "baseline", dur: 2 }),
  seg({ i: 1, emotion: "happy", dur: 3 }),
  seg({ i: 2, emotion: "happy", dur: 1.2, outlier: "flagged" }),
  seg({ i: 3, emotion: "happy", dur: 2, outlier: "dropped" }),
  seg({ i: 4, emotion: "sad", dur: 1.5 }),
  seg({ i: 5, emotion: "happy", dur: 0.9, failure: "extract", ok: false }),
];

function result(over: Partial<Result> = {}): Result {
  return {
    duration: 90, speakers: ["spk_0"], target: "spk_0", utterances: 6, min_stem: 4,
    stems: [
      { emotion: "baseline", seconds: 5, segments: 3, eligible: true, cues: [] },
      { emotion: "happy", seconds: 4.2, segments: 2, eligible: true, cues: [] },
      { emotion: "sad", seconds: 1.5, segments: 1, eligible: false, cues: [] },
    ],
    segments: SEGMENTS,
    ...over,
  };
}

describe("what a segment says about itself", () => {
  it("names each reason a segment cannot feed a stem", () => {
    expect(blockedReason(seg({ i: 1 }))).toBeNull();
    expect(blockedReason(seg({ i: 1, failure: "extract" }))).toMatch(/decoded/);
    expect(blockedReason(seg({ i: 1, failure: "classify" }))).toMatch(/classifier/);
    expect(blockedReason(seg({ i: 1, outlier: "dropped" }))).toMatch(/not the target speaker/);
    expect(blockedReason(seg({ i: 1, ok: false }))).toMatch(/no audio/);
  });

  it("treats a FLAGGED segment as castable — it is in the stems already", () => {
    // "flagged" means "looked unlike the rest and we kept it". Only "dropped"
    // removes audio, and only that is refused.
    expect(blockedReason(seg({ i: 2, outlier: "flagged" }))).toBeNull();
  });
});

describe("the segments under a ledger row", () => {
  const assigned = [1, 2];

  it("lists what is in the stem plus everything labelled with the emotion", () => {
    const rows = boardRows(result(), "happy", assigned);
    expect(rows.map((r) => r.i)).toEqual([1, 2, 3, 5]);
    expect(rows.filter((r) => r.assigned).map((r) => r.i)).toEqual([1, 2]);
  });

  it("keeps the rejected ones visible, and marks them unavailable", () => {
    // The dead end this board exists to open: "detected, too short" and
    // "removed as a bystander" used to be grey badges with no audio behind them.
    const rows = boardRows(result(), "happy", assigned);
    const dropped = rows.find((r) => r.i === 3)!;
    expect(dropped.available).toBe(false);
    expect(dropped.blocked).toMatch(/not the target speaker/);
  });

  it("shows a segment that was MOVED in, and says it is labelled otherwise", () => {
    const rows = boardRows(result(), "happy", [1, 4]);
    const moved = rows.find((r) => r.i === 4)!;
    expect(moved.assigned).toBe(true);
    expect(moved.foreign).toBe(true);
  });

  it("a borrowed baseline lists the audio it really holds, not the neutral labels", () => {
    // plan_baseline tops a short neutral stem up from other emotions; the
    // server publishes that map and the board renders it verbatim.
    const rows = boardRows(result(), "baseline", [0, 4, 1]);
    expect(rows.map((r) => r.i)).toEqual([0, 1, 4]);
    expect(rows.every((r) => r.assigned)).toBe(true);
  });

  it("offers only castable segments from elsewhere", () => {
    const from = castableElsewhere(result(), "happy", [1, 2]);
    expect(from.map((r) => r.i)).toEqual([0, 4]);   // never 3 (dropped) or 5 (no audio)
  });
});

describe("what a click does", () => {
  it("excludes and re-includes in recording order", () => {
    expect(toggleSegment([1, 2, 3], 2)).toEqual([1, 3]);
    // Re-added where it belongs: concat_wavs splices the sequence it is given,
    // and utterances out of order are what makes a stem sound assembled.
    expect(toggleSegment([1, 3], 2)).toEqual([1, 2, 3]);
  });

  it("moves a segment as ONE map, so two stems never look half-moved", () => {
    const next = moveSegment({ happy: [1, 2], sad: [4] }, 2, "happy", "sad");
    expect(next).toEqual({ happy: [1], sad: [2, 4] });
  });

  it("moving into the stem a segment is already in changes nothing", () => {
    expect(moveSegment({ happy: [1, 2] }, 2, "happy", "happy")).toEqual({});
  });

  it("refuses to send an edit that would empty a stem", () => {
    expect(wouldEmpty({ happy: [] })).toBe("happy");
    expect(wouldEmpty({ happy: [1] })).toBeNull();
  });
});

describe("the seconds bar", () => {
  it("fills against the clone minimum and stops there", () => {
    expect(stemProgress(2, 4)).toBe(0.5);
    expect(stemProgress(9, 4)).toBe(1);
    expect(stemProgress(0, 4)).toBe(0);
  });

  it("says how much a short stem is short by, and nothing once it clears", () => {
    const stem = { emotion: "sad", seconds: 3.6, segments: 2, eligible: false, cues: [] };
    expect(shortBy(stem, 4)).toBe(0.4);
    expect(shortBy({ ...stem, seconds: 4.1, eligible: true }, 4)).toBeNull();
  });
});

// ── the reducer half ────────────────────────────────────────────────────────
function job(over: Partial<Job> = {}): Job {
  return {
    status: "running", step: null, steps: [], partial: {},
    speakers: null, duration: 0, result: null, error: null, ...over,
  };
}

const proposed = { baseline: [0, 4, 1], happy: [1, 2], sad: [4] };

const reviewing = [
  { type: "SCAN_STARTED", jobId: "j1" } as const,
  { type: "JOB_POLLED", job: job({ status: "done", result: result(),
    casting: { assignments: proposed, edited: [] } }) } as const,
].reduce(reducer, initialState);

function cast(over: Partial<CastResult> = {}): CastResult {
  return {
    min_stem: 4, reset: false, edited: ["happy"], changed: ["happy"],
    stems: [
      { emotion: "happy", seconds: 3, segments: 1, eligible: false, note: null,
        assigned: [1], proposed: [1, 2], edited: true, takes: false },
    ],
    ...over,
  };
}

describe("casting state", () => {
  it("takes the proposed splice from the backend, never from the labels", () => {
    expect(reviewing.assignments).toEqual(proposed);
    expect(reviewing.dirty).toEqual([]);
  });

  it("CAST_SEGMENTS answers the click without moving any measurement", () => {
    const s = reducer(reviewing, { type: "CAST_SEGMENTS", assignments: { happy: [1] } });
    expect(s.assignments.happy).toEqual([1]);
    expect(s.assignments.sad).toEqual([4]);            // untouched rows stay put
    // The LENGTH is a measurement of a file the service writes; the browser is
    // not allowed to guess it while the re-splice is in flight.
    expect(s.result!.stems.find((x) => x.emotion === "happy")!.seconds).toBe(4.2);
  });

  it("CAST_SYNCED moves the ledger to what was actually written", () => {
    const s = reducer(reviewing, { type: "CAST_SYNCED", cast: cast() });
    const happy = s.result!.stems.find((x) => x.emotion === "happy")!;
    expect(happy.seconds).toBe(3);
    expect(happy.segments).toBe(1);
    expect(happy.eligible).toBe(false);
    expect(s.dirty).toEqual(["happy"]);
    // A stem cast below the clone minimum is descoped rather than left ticked
    // for a commit the backend would refuse.
    expect(s.selected.has("happy")).toBe(false);
    expect(s.selected.has("baseline")).toBe(true);
  });

  it("a stem that crosses the line back is not silently re-ticked", () => {
    // Keeping is the user's click; re-adding a row they descoped would undo a
    // decision they made.
    const under = reducer(reviewing, { type: "CAST_SYNCED", cast: cast() });
    const over = reducer(under, { type: "CAST_SYNCED", cast: cast({
      stems: [{ emotion: "happy", seconds: 5, segments: 2, eligible: true, note: null,
        assigned: [1, 2], proposed: [1, 2], edited: false, takes: false }] }) });
    expect(over.result!.stems.find((x) => x.emotion === "happy")!.eligible).toBe(true);
    expect(over.selected.has("happy")).toBe(false);
  });

  it("withdraws the alternative takes of a row that was re-cast", () => {
    const withTakes = reducer(reviewing, { type: "JOB_POLLED", job: job({
      status: "done",
      casting: { assignments: proposed, edited: [] },
      result: result({ stems: [
        { emotion: "happy", seconds: 4.2, segments: 2, eligible: true, cues: [],
          recipes: [{ id: "full", label: "everything", how: "", seconds: 4.2, segments: 2, default: true },
                    { id: "longest", label: "longest takes", how: "", seconds: 3, segments: 1 }] },
      ] }) }) });
    const chosen = reducer(withTakes, { type: "CHOOSE_RECIPE", emotion: "happy", recipeId: "longest" });
    const s = reducer(chosen, { type: "CAST_SYNCED", cast: cast() });
    // The takes described the splice the user has just replaced; an offer the
    // backend would refuse at commit must leave the screen with it.
    expect(s.result!.stems[0].recipes).toBeUndefined();
    expect(s.auditions).toEqual({});
  });

  it("a reset carries the pipeline's own note back with its numbers", () => {
    const edited = reducer(reviewing, { type: "CAST_SYNCED", cast: cast() });
    const back = reducer(edited, { type: "CAST_SYNCED", cast: cast({
      reset: true, edited: [], changed: ["happy"],
      stems: [{ emotion: "happy", seconds: 4.2, segments: 2, eligible: true,
        note: "topped up with 1 x calm", assigned: [1, 2], proposed: [1, 2],
        edited: false, takes: true }] }) });
    const happy = back.result!.stems.find((x) => x.emotion === "happy")!;
    expect(happy.seconds).toBe(4.2);
    expect(happy.note).toBe("topped up with 1 x calm");
    expect(back.dirty).toEqual([]);
  });

  it("a fresh ledger, an analyze failure and a reset all forget the casting", () => {
    const edited = reducer(reviewing, { type: "CAST_SYNCED", cast: cast() });
    const rescanned = reducer(edited, { type: "SCAN_STARTED", jobId: "j2" });
    expect(rescanned.assignments).toEqual({});
    expect(rescanned.dirty).toEqual([]);

    const failed = reducer(edited, { type: "JOB_POLLED", job: job({ status: "error", error: "nope" }) });
    expect(failed.phase).toBe("upload");
    expect(failed.assignments).toEqual({});

    for (const kind of ["start-over", "scan-another"] as const) {
      const s = reducer(edited, { type: "RESET", kind });
      expect(s.assignments).toEqual({});
      expect(s.dirty).toEqual([]);
    }
  });

  it("CAST_SYNCED before a ledger exists is a no-op, not a crash", () => {
    expect(reducer(initialState, { type: "CAST_SYNCED", cast: cast() })).toBe(initialState);
  });
});

describe("what was measured, and by whom", () => {
  const stem = (over: Partial<Stem> = {}): Stem =>
    ({ emotion: "happy", seconds: 4.2, segments: 2, eligible: true, cues: [], ...over });

  it("shows the number when the pipeline measured one", () => {
    const cell = stemIdentity(stem({ identity: 0.9137 }), false, "cosine similarity");
    expect(cell.tone).toBe("measured");
    expect(cell.text).toBe("identity 0.91");
    // The service's own caveat is quoted, not paraphrased.
    expect(cell.title).toMatch(/cosine similarity/);
  });

  it("keeps 'not measured' and 're-cast' as two DIFFERENT states", () => {
    // The service pops a stem's identity when the user re-casts it, because the
    // score described a splice that no longer exists. Presenting that the same
    // way as "this backend never measured anything" hides the reason the number
    // vanished after the user's own edit.
    const never = stemIdentity(stem(), false);
    const recast = stemIdentity(stem(), true);
    expect(never.tone).toBe("absent");
    expect(recast.tone).toBe("recast");
    expect(recast.text).toMatch(/re-cast/);
    expect(recast.title).toMatch(/replaced that splice/i);
  });

  it("never renders an absent measurement as a number", () => {
    expect(stemIdentity(stem(), false).text).not.toMatch(/\d/);
    expect(stemIdentity(stem({ identity: 0 }), false).text).toBe("identity 0.00");
  });

  it("carries the identity column only when there is something to say", () => {
    const measured = [stem({ identity: 0.9 }), stem({ emotion: "sad" })];
    const none = [stem(), stem({ emotion: "sad" })];
    expect(identityMeasured(measured, [])).toBe(true);
    expect(identityMeasured(none, [])).toBe(false);
    // A row the user re-cast keeps the column, so the number's disappearance is
    // explained rather than silent.
    expect(identityMeasured(none, ["happy"])).toBe(true);
  });

  it("tells a paid second opinion apart from the cheap first guess", () => {
    const paid = labelSource(seg({ i: 1, model: "gemini-3.1-pro-preview", escalation: "escalated" }))!;
    const quick = labelSource(seg({ i: 1, model: "gemini-3.6-flash" }))!;
    expect(paid.tone).toBe("paid");
    expect(paid.text).toMatch(/second opinion/);
    expect(quick.tone).toBe("quick");
    expect(quick.title).toMatch(/gemini-3.6-flash/);
  });

  it("says an unsure label was NOT re-checked, and why", () => {
    // Both halves the service records separately: the budget ran out, and the
    // escalation was attempted and failed. Either way the flash guess stands,
    // and either way that must not read like a confident answer.
    const skipped = labelSource(seg({ i: 1, model: "gemini-3.6-flash", escalation: "skipped" }))!;
    const failed = labelSource(seg({ i: 1, model: "gemini-3.6-flash", escalation: "failed" }))!;
    expect(skipped.tone).toBe("unsure");
    expect(skipped.title).toMatch(/budget/);
    expect(failed.tone).toBe("unsure");
    expect(failed.title).toMatch(/failed/);
  });

  it("badges nothing where there is no classifier to distinguish", () => {
    // Sovereign mode labels everything locally; a badge on every row would be
    // noise about a distinction that does not exist there.
    expect(labelSource(seg({ i: 1, model: "local" }))).toBeNull();
    expect(labelSource(seg({ i: 1 }))).toBeNull();
    expect(labelSource(seg({ i: 1, model: "error" }))!.text).toBe("not classified");
  });
});

it("CAST_SYNCED drops a re-cast stem's identity, and only that one's", () => {
  // The service pops `identity` for every stem it re-spliced (it measured the
  // splice the user just replaced) and the answer carries no identity at all.
  // Merging that answer over the old rows would leave a stale number standing
  // over audio that no longer exists — and would silently keep it on the rows
  // the user never touched too if the client over-corrected the other way.
  const scored = [
    { type: "SCAN_STARTED", jobId: "j1" } as const,
    { type: "JOB_POLLED", job: job({ status: "done", casting: { assignments: proposed, edited: [] },
      result: result({ stems: [
        { emotion: "happy", seconds: 4.2, segments: 2, eligible: true, cues: [], identity: 0.91 },
        { emotion: "sad", seconds: 1.5, segments: 1, eligible: false, cues: [], identity: 0.88 },
      ] }) }) } as const,
  ].reduce(reducer, initialState);

  const synced = reducer(scored, { type: "CAST_SYNCED", cast: cast({
    edited: ["happy"], changed: ["happy"],
    stems: [
      { emotion: "happy", seconds: 3, segments: 1, eligible: false, note: null,
        assigned: [1], proposed: [1, 2], edited: true, takes: false },
      { emotion: "sad", seconds: 1.5, segments: 1, eligible: false, note: null,
        assigned: [4], proposed: [4], edited: false, takes: false },
    ],
  }) });

  const by = Object.fromEntries(synced.result!.stems.map((s) => [s.emotion, s]));
  expect(by.happy.identity).toBeUndefined();
  expect(by.sad.identity).toBe(0.88);
});
