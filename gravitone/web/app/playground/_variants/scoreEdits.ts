// The two edits a placed region can take — moving an edge and re-aiming it.
//
// Pure, and shared by both score surfaces: the solo editor and every lane of a
// scene do exactly this arithmetic, and they used to do it twice. The clamping
// is the part that must not diverge — an edge that may cross its own opposite
// edge inverts a region, and an edge that may cross its NEIGHBOUR produces an
// overlap the grammar cannot express.
//
// Neither function touches state or the string: they answer with the regions
// that should replace the ones handed in, or with nothing at all, and the
// caller decides what to say about it.

import { regionProblem, scoreRegion, type ScoreRegion } from "./playgroundHelpers";

/** Move one edge of region `i` to offset `to`, clamped by its neighbours and by
 *  its own opposite edge. Null when there is no such region or when the clamp
 *  left it exactly where it was — the caller's cue to leave both the string and
 *  the notice alone, rather than emit a no-op edit. */
export function resizeRegions(
  text: string,
  regions: ScoreRegion[],
  i: number,
  edge: "start" | "end",
  to: number,
): ScoreRegion[] | null {
  const r = regions[i];
  if (!r) return null;
  const floor = i > 0 ? regions[i - 1].end : 0;
  const ceil = i < regions.length - 1 ? regions[i + 1].start : text.length;
  const next =
    edge === "start"
      ? scoreRegion(Math.max(floor, Math.min(to, r.end - 1)), r.end, r.value)
      : scoreRegion(r.start, Math.min(ceil, Math.max(to, r.start + 1)), r.value);
  if (next.start === r.start && next.end === r.end) return null;
  return regions.map((x, j) => (j === i ? next : x));
}

/** Re-aim region `i` at another emotion without moving it. `why` is the
 *  refusal, in the composer's own words, and it is a sentence rather than a
 *  silently dropped edit; both fields are null when there is no such region. */
export function retagRegions(
  text: string,
  regions: ScoreRegion[],
  i: number,
  value: string,
): { regions: ScoreRegion[] | null; why: string | null } {
  const r = regions[i];
  if (!r) return { regions: null, why: null };
  const why = regionProblem(text, scoreRegion(r.start, r.end, value), regions.filter((_, j) => j !== i));
  if (why) return { regions: null, why };
  return { regions: regions.map((x, j) => (j === i ? scoreRegion(x.start, x.end, value) : x)), why: null };
}
