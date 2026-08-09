// The partition the composer's text surface is painted from, and the paint
// itself — both pure, both derived from the same offsets the string is written
// back with. ScoreText owns the two boxes and the alignment check that decides
// whether this paint is allowed to show at all; this file owns nothing that
// touches the DOM, which is why it can be tested exhaustively.

import { emotionMeta } from "@/lib/emotions";
import type { ScoreRegion } from "./playgroundHelpers";

/** One painted run of the surface: a slice of the text that is uniformly
 *  directed (or not), uniformly PROPOSED (or not), and uniformly selected (or
 *  not). `value` and `suggested` are mutually exclusive by construction — a
 *  suggestion over words the user already directed is dropped before it ever
 *  reaches here (suggest.ts::propose). */
export type TextRun = { start: number; end: number; value?: string; suggested?: string; selected: boolean };

/**
 * Slice `text` at every region edge AND every selection edge.
 *
 * Cutting on both sets of boundaries is what lets one pass of spans carry both
 * meanings without any rectangle arithmetic: a run is inside a region or it is
 * not, and it is inside the selection or it is not, and the flow does the
 * positioning. Regions are assumed non-overlapping — the grammar has no nesting
 * and `normalizeRegions` guarantees it — so a run belongs to at most one.
 *
 * A zero-width selection (a bare caret) contributes no boundary: there is
 * nothing to show the user they are about to wrap.
 */
export function runs(
  text: string,
  regions: ScoreRegion[],
  selection?: { start: number; end: number } | null,
  suggestions: ScoreRegion[] = [],
): TextRun[] {
  const len = text.length;
  if (len === 0) return [];
  const selFrom = selection ? Math.max(0, Math.min(selection.start, selection.end)) : 0;
  const selTo = selection ? Math.min(len, Math.max(selection.start, selection.end)) : 0;
  const hasSel = !!selection && selTo > selFrom;

  const cuts = new Set<number>([0, len]);
  for (const r of [...regions, ...suggestions]) {
    if (r.start > 0 && r.start < len) cuts.add(r.start);
    if (r.end > 0 && r.end < len) cuts.add(r.end);
  }
  if (hasSel) {
    if (selFrom > 0 && selFrom < len) cuts.add(selFrom);
    if (selTo > 0 && selTo < len) cuts.add(selTo);
  }

  const edges = [...cuts].sort((a, b) => a - b);
  const out: TextRun[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i];
    const end = edges[i + 1];
    if (end <= start) continue;
    const region = regions.find((r) => r.start <= start && end <= r.end);
    const ghost = region ? undefined : suggestions.find((r) => r.start <= start && end <= r.end);
    out.push({
      start,
      end,
      value: region?.value,
      suggested: ghost?.value,
      selected: hasSel && selFrom <= start && end <= selTo,
    });
  }
  return out;
}

/**
 * How one run is painted.
 *
 * Colour is never the ONLY encoding: a directed run also carries a 2px rule
 * under it, and dark 1px rules down both sides so two ADJACENT regions read as
 * two spans rather than one gradient. All three are `inset` box-shadows, which
 * cost no layout — a real border or padding here would push characters out of
 * step with the textarea and trip the alignment check.
 */
export function runStyle(run: TextRun): React.CSSProperties {
  const shadows: string[] = [];
  let background: string | undefined;
  let decoration: React.CSSProperties = {};
  if (run.suggested) {
    // A PROPOSAL, drawn as one: a fainter wash and a DASHED rule rather than
    // the solid one a placed region gets. The difference is a shape, not an
    // opacity, so "the machine guessed this" and "I decided this" stay distinct
    // for a reader who cannot compare two tints. `text-decoration` is used
    // rather than a fourth box-shadow because box-shadows cannot be dashed —
    // and, like them, it costs no layout, so the mirror stays in step.
    const { hue } = emotionMeta(run.suggested);
    background = `hsl(${hue} 82% 55% / 0.10)`;
    decoration = {
      textDecorationLine: "underline",
      textDecorationStyle: "dashed",
      textDecorationColor: `hsl(${hue} 88% 68% / 0.9)`,
      textUnderlineOffset: "3px",
    };
  }
  if (run.value) {
    const { hue } = emotionMeta(run.value);
    background = `hsl(${hue} 82% 55% / 0.26)`;
    shadows.push(
      `inset 0 -2px 0 0 hsl(${hue} 88% 62% / 0.95)`,
      "inset 1px 0 0 0 rgba(4,6,12,0.85)",
      "inset -1px 0 0 0 rgba(4,6,12,0.85)",
    );
  }
  if (run.selected) {
    // The selection the picker steals focus away from. A portal dialog blurs the
    // textarea, so the NATIVE highlight vanishes exactly when the user is
    // choosing what to do to it; this is that highlight, drawn by us and
    // therefore still there.
    background = run.value ? background : "rgba(148,180,255,0.22)";
    shadows.push("inset 0 0 0 1px rgba(190,214,255,0.7)");
  }
  return { ...decoration, background, boxShadow: shadows.length ? shadows.join(", ") : undefined };
}
