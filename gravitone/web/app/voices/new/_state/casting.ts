// The Segment Casting Board's pure logic: which segments a stem is built from,
// which of them can be cast at all, and what a click does to the assignment map.
//
// Kept out of the component for the same reason the Audition Room's ladder is:
// "what will actually be cloned" is a correctness question, and it should be
// testable without rendering an audio player.
//
// One rule underpins all of it: the browser NEVER decides how long a stem is.
// Seconds and eligibility are measurements of a file the service just wrote, so
// they only ever arrive from POST /api/ingest/{job}/stems. This module decides
// membership; the backend decides length.

import type { Result, Segment, Stem } from "./machine";

/** A segment as the board renders it, next to the stem it belongs to. */
export type SegmentRow = Segment & {
  /** In this stem's current splice. */
  assigned: boolean;
  /** Can be cast at all — has audio and was not rejected by the pipeline. */
  available: boolean;
  /** Why not, in the pipeline's own terms. Null when it is available. */
  blocked: string | null;
  /** Labelled as something other than the stem it is sitting under. */
  foreign: boolean;
};

/**
 * Why a segment cannot feed a stem — the same four facts the service refuses
 * with, so the row is greyed for a stated reason instead of just being greyed.
 * Null means it can be cast.
 */
export function blockedReason(s: Segment): string | null {
  if (s.failure === "extract") return "this span of the recording could not be decoded";
  if (s.failure === "classify") return "the classifier said nothing about this clip";
  if (s.failure) return `it could not be prepared (${s.failure})`;
  if (s.outlier === "dropped") return "measured as not the target speaker, so it feeds no stem";
  if (s.ok === false) return "no audio was extracted for this segment";
  return null;
}

/** The current splice of one emotion: the server's map when there is one, else
 *  the stem's own proposal. Never derived from the labels — a borrowed baseline
 *  is not "the neutral segments" (service/ingest.py::plan_baseline). */
export function assignedOf(
  assignments: Record<string, number[]>, emotion: string,
): number[] {
  return assignments[emotion] ?? [];
}

/**
 * The segments to list under one ledger row: everything currently in the stem,
 * plus every segment LABELLED with that emotion (so an excluded one can be put
 * back, and a rejected one can be heard and understood). Index order, which is
 * recording order.
 */
export function boardRows(
  result: Result | null, emotion: string, assigned: number[],
): SegmentRow[] {
  const segments = result?.segments ?? [];
  const inStem = new Set(assigned);
  const rows: SegmentRow[] = [];
  for (const s of segments) {
    if (!inStem.has(s.i) && s.emotion !== emotion) continue;
    const blocked = blockedReason(s);
    rows.push({
      ...s,
      assigned: inStem.has(s.i),
      available: blocked === null,
      blocked,
      foreign: s.emotion !== emotion,
    });
  }
  return rows.sort((a, b) => a.i - b.i);
}

/** Segments the user could move INTO this stem from elsewhere: castable, not
 *  already here. Offered per source emotion so a move reads as a move. */
export function castableElsewhere(
  result: Result | null, emotion: string, assigned: number[],
): SegmentRow[] {
  const inStem = new Set(assigned);
  return (result?.segments ?? [])
    .filter((s) => s.emotion !== emotion && !inStem.has(s.i) && blockedReason(s) === null)
    .map((s) => ({ ...s, assigned: false, available: true, blocked: null, foreign: true }));
}

/** Include/exclude one segment. Ascending index order — `concat_wavs` splices
 *  the sequence it is given, and utterances out of recording order are the one
 *  thing that makes a stem sound assembled. */
export function toggleSegment(assigned: number[], i: number): number[] {
  const next = assigned.includes(i) ? assigned.filter((x) => x !== i) : [...assigned, i];
  return next.sort((a, b) => a - b);
}

/**
 * Move a segment from one stem to another, as ONE assignment map: both sides
 * change together, so the debounced re-splice is a single request and the two
 * stems can never be observed half-moved.
 */
export function moveSegment(
  assignments: Record<string, number[]>, i: number, from: string, to: string,
): Record<string, number[]> {
  if (from === to) return {};
  return {
    [from]: assignedOf(assignments, from).filter((x) => x !== i),
    [to]: toggleSegment(assignedOf(assignments, to).filter((x) => x !== i), i),
  };
}

/** Does this edit empty a stem? The service refuses it by name ("descope the
 *  emotion instead"); the board should not send it in the first place. */
export function wouldEmpty(next: Record<string, number[]>): string | null {
  for (const [emotion, idxs] of Object.entries(next)) {
    if (idxs.length === 0) return emotion;
  }
  return null;
}

/** How far a stem is along the clone minimum, 0..1 — the fill of the seconds
 *  bar. Clamped at 1: past the minimum the bar is full, and the number beside
 *  it carries the rest of the truth. */
export function stemProgress(seconds: number, minStem: number): number {
  if (!(minStem > 0)) return 1;
  return Math.max(0, Math.min(1, seconds / minStem));
}

/** How much more audio this stem needs, to one decimal — null once it clears
 *  the bar. The sentence the board puts under a short stem. */
export function shortBy(stem: Stem, minStem: number): number | null {
  const gap = minStem - stem.seconds;
  return gap > 0.05 ? Math.round(gap * 10) / 10 : null;
}

/** Is this emotion's splice still the one the pipeline proposed? Compared
 *  against the SERVER's answer (`dirty`), never re-derived here. */
export function isEdited(dirty: string[], emotion: string): boolean {
  return dirty.includes(emotion);
}

// ── what was MEASURED, and by whom ────────────────────────────────────────────
//
// Two numbers the pipeline has always produced and the review screen has always
// thrown away: how much each spliced stem still sounds like the speaker, and
// whether a segment's emotion label came from the cheap classifier or from the
// paid second opinion. Both are presented the same way the rest of this flow
// presents a measurement: the absent case is a STATE with its own sentence, and
// nothing is ever rounded up into a claim the backend did not make.

/** What the ledger's identity cell says. `tone` picks the palette, never the
 *  meaning: `measured` is a number, `recast` and `absent` are both "no number"
 *  for two different and non-interchangeable reasons. */
export type IdentityCell = {
  tone: "measured" | "recast" | "absent";
  text: string;
  title: string;
};

/**
 * The per-stem identity match, as a cell.
 *
 * `measures` is the service's own caveat sentence (result.fidelity.measures) —
 * quoted when it is there so the studio does not write its own definition of a
 * similarity score.
 */
export function stemIdentity(
  stem: Stem, edited: boolean, measures?: string | null,
): IdentityCell {
  if (typeof stem.identity === "number") {
    return {
      tone: "measured",
      text: `identity ${stem.identity.toFixed(2)}`,
      title: "Identity match: how closely this spliced stem still sounds like the "
        + "same speaker (1.00 is identical). It says nothing about whether the "
        + "take is good." + (measures ? ` Measured as ${measures}.` : ""),
    };
  }
  if (edited) {
    return {
      tone: "recast",
      text: "re-cast · not measured",
      title: "The score here described the pipeline's own splice. You replaced "
        + "that splice, so the number was dropped rather than left standing over "
        + "audio it never measured — the voice made from this stem is scored "
        + "when it is cloned.",
    };
  }
  return {
    tone: "absent",
    text: "not measured",
    title: "This scan did not measure speaker identity for this stem.",
  };
}

/** Should the ledger carry an identity column at all? Only when there is
 *  something to say: a pipeline that measured nothing must not render a column
 *  of "not measured", and a row the user re-cast keeps the column alive so the
 *  disappearance of its number is explained rather than silent. */
export function identityMeasured(stems: Stem[], dirty: string[]): boolean {
  return stems.some((s) => typeof s.identity === "number") || dirty.length > 0;
}

/** Where a segment's emotion label came from. Null when there is nothing worth
 *  a badge — a mode with no classifier at all, or a label with no provenance. */
export type LabelSource = {
  tone: "paid" | "quick" | "unsure" | "none";
  text: string;
  title: string;
};

export function labelSource(s: Segment): LabelSource | null {
  const model = s.model ?? null;
  // The escalation is the expensive half and it is stated first, including both
  // ways it can NOT have happened: the service records "skipped" (the scan's
  // escalation budget was spent) and "failed" separately from a label that was
  // simply confident, and a client that showed all three alike would present a
  // guess as a checked answer.
  if (s.escalation === "escalated") {
    return {
      tone: "paid", text: "second opinion",
      title: `The quick classifier was unsure about this clip, so it was re-labelled `
        + `by the more expensive model${model ? ` (${model})` : ""}.`,
    };
  }
  if (s.escalation === "skipped") {
    return {
      tone: "unsure", text: "unsure · not re-checked",
      title: "The quick classifier was unsure, and this scan's budget for second "
        + "opinions was already spent — so its first guess stands.",
    };
  }
  if (s.escalation === "failed") {
    return {
      tone: "unsure", text: "unsure · re-check failed",
      title: "The quick classifier was unsure, the second opinion was attempted "
        + "and failed, so its first guess stands.",
    };
  }
  if (model === "error") {
    return {
      tone: "none", text: "not classified",
      title: "The classifier said nothing about this clip, so it fell back to the "
        + "baseline label.",
    };
  }
  // Sovereign mode classifies nothing and labels everything locally; a badge on
  // every row would be noise about a distinction that does not exist there.
  if (!model || model === "local") return null;
  return {
    tone: "quick", text: "quick label",
    title: `Labelled by the fast classifier (${model}); it was confident enough that `
      + "no second opinion was bought.",
  };
}
