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
