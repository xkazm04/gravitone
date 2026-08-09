// The A/B's vocabulary: what a side IS, what gets sent for it, and the two
// readings of the backend's per-segment report that decide whether the
// comparison is worth anything. All pure — the panel does the rendering, the
// tile does the drawing, and neither has to re-derive these.

import { stripTags, type Take } from "./playgroundHelpers";

export const AB_SIDES = ["A", "B"] as const;
export type AbSide = (typeof AB_SIDES)[number];

/**
 * Wrap a line in one emotion's metatag.
 *
 * `baseline` is sent UNTAGGED on purpose: it is what untagged text already
 * resolves to, so tagging it would add a round-trip through the tag grammar to
 * arrive at the identical request — and a difference in the request is a
 * difference the comparison cannot account for.
 */
export function taggedFor(line: string, emotion: string): string {
  const plain = stripTags(line).trim();
  if (!plain || emotion === "baseline") return plain;
  return `[${emotion}]${plain}[/${emotion}]`;
}

/**
 * Which Voice actually spoke a take, according to the backend's own per-segment
 * report — not according to what we asked for.
 *
 * Returns null when the report is absent (a browser-fallback take, or an older
 * proxy that dropped the header): absent is absent, and inventing "presumably
 * the one we requested" is how a fallback becomes invisible.
 */
export function spokenVoice(t: Take | null): { voiceId: string; used: string } | null {
  const seg = t?.segments?.[0];
  if (!seg?.voice_id) return null;
  return { voiceId: seg.voice_id, used: seg.used };
}

/**
 * The warning this panel exists to be able to give: the two sides are the same
 * recording, so the comparison shows nothing. Null when they genuinely differ,
 * or when we cannot tell.
 */
export function sameVoiceWarning(a: Take | null, b: Take | null): string | null {
  const va = spokenVoice(a), vb = spokenVoice(b);
  if (!va || !vb || va.voiceId !== vb.voiceId) return null;
  return `Both sides were spoken by the same Voice (${va.used}). This Character has `
    + `not recorded one of the two emotions, so the request fell back — you are `
    + `hearing one recording twice, not a comparison. Record the missing slot and `
    + `run it again.`;
}

export type Side = {
  emotion: string;
  take: Take | null;
  state: "idle" | "rendering" | "done" | "failed";
  reason?: string;
};

export const emptySide = (emotion: string): Side => ({ emotion, take: null, state: "idle" });
