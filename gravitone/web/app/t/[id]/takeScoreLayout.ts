// Where a shared take's segments SIT on its timeline — the pure arithmetic
// behind the score, with no React in it.

import { type SharedTake } from "@/lib/takes";

export const LANE_HEIGHT = 46;
/** Stacked lanes are shorter — a six-hander has to stay one screen. */
export const CAST_LANE_HEIGHT = 38;

export type Placed = {
  index: number;
  start: number;
  end: number;
  segment: SharedTake["segments"][number];
};

/**
 * Place a shared take's segments on its timeline.
 *
 * Same rule as the console's `segmentRegions`: the reported per-segment seconds
 * are SCALED so the last span ends exactly at the take's stated duration, and a
 * report with no usable seconds falls back to an even division — which is a
 * labelled guess at WHERE each segment is, never a claim about how long it took
 * to say. Kept local (and typed to the SHARE payload, which carries no
 * voice_id/characterId) so the public page does not depend on the playground's
 * take model.
 */
export function placeSegments(
  segments: SharedTake["segments"],
  duration: number,
): { spans: Placed[]; even: boolean } {
  if (segments.length === 0 || !(duration > 0)) return { spans: [], even: false };
  const secs = segments.map((s) => (Number.isFinite(s.seconds) && s.seconds > 0 ? s.seconds : 0));
  const sum = secs.reduce((a, b) => a + b, 0);
  const share = duration / segments.length;
  let at = 0;
  const spans = segments.map((segment, index) => {
    const len = sum > 0 ? (secs[index] / sum) * duration : share;
    const start = at;
    at = index === segments.length - 1 ? duration : Math.min(duration, at + len);
    return { index, start, end: at, segment };
  });
  return { spans, even: sum <= 0 };
}

/** The spans one Character speaks, in a stacked-lane score. Absolute time is
 *  kept — a lane is a filtered view of the SAME timeline, so the gaps between
 *  a Character's spans are the moments somebody else was speaking. */
export type Lane = { characterId: string; name: string; spans: Placed[] };

/**
 * Split placed spans into one lane per speaker, or a single lane when the take
 * names no cast (a solo take, and every take published before segments carried
 * a speaker).
 *
 * Order is FIRST-SPOKEN, not alphabetical: a scene reads top to bottom in the
 * order its voices enter.
 */
export function laneSegments(spans: Placed[]): Lane[] {
  const lanes: Lane[] = [];
  const at = new Map<string, Lane>();
  for (const span of spans) {
    const id = span.segment.character_id ?? "";
    let lane = at.get(id);
    if (!lane) {
      lane = { characterId: id, name: span.segment.character_name || id, spans: [] };
      at.set(id, lane);
      lanes.push(lane);
    }
    lane.spans.push(span);
  }
  return lanes;
}

/** The timeline the score draws on: the segments' own reported seconds when it
 *  has them, else the take's stated length. */
export function scoreDuration(take: SharedTake): number {
  const reported = take.segments.reduce((n, s) => n + (s.seconds > 0 ? s.seconds : 0), 0);
  return reported > 0 ? reported : take.seconds;
}

/** Whether this take has a score to draw at all — the question the share page
 *  asks before deciding whether the card still needs its segment ribbon. */
export function hasScore(take: SharedTake): boolean {
  return placeSegments(take.segments, scoreDuration(take)).spans.length > 0;
}
