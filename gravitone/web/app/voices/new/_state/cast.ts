// The Casting Board's selection rules — one video, many Characters.
//
// The speaker screen used to be a fork: pick ONE voice, the rest of the
// recording is thrown away. The backend never needed that narrowing (analyze
// computes stats and a preview for every speaker, and the two paid calls are
// already spent), so this module holds the pure half of the multi-select: what
// the selection means, when it cannot be sent, and how the result reads back.
//
// Everything here is a MIRROR of service/ingest_api.py — the refusals are
// stated in the browser so a user learns them while typing, and the service
// enforces every one of them again. When they disagree, the service wins.

import { characterSlug } from "@/lib/slugs";
import type { CastJob, CastMember, Speaker } from "./machine";

/** service/ingest_api.py::MAX_CAST_MEMBERS. Bounds spend as much as UI: each
 *  member is a labelling fan-out against the shared per-job budget plus a
 *  clone phase of its own. */
export const MAX_CAST_MEMBERS = 6;

/** {speaker id -> the name typed for it}. Absent = not selected; "" = selected
 *  and unnamed, which is a state the user is mid-way through, not an error to
 *  shout about until they try to send it. */
export type CastSelection = Record<string, string>;

export type CastMemberReq = { speaker_id: string; character: string };

/** The request body, in the order the speakers are shown — so the progress the
 *  user then watches runs down the same list they just ticked. */
export function castMembers(selection: CastSelection, speakers: Speaker[]): CastMemberReq[] {
  return speakers
    .filter((s) => selection[s.id] !== undefined)
    .map((s) => ({ speaker_id: s.id, character: (selection[s.id] ?? "").trim() }));
}

/**
 * Why this selection cannot be cast, in the user's own terms — or null.
 *
 * Two of these are the SERVICE's refusals said early (unnamed member, more than
 * MAX_CAST_MEMBERS), and one is the trap the service can only answer with a
 * slug: two different names that slug onto the same character id would race
 * each other for the same (character, emotion) slots, so the second speaker's
 * voices would be skipped as "already held" and the user would be told two
 * people were cloned when one was.
 */
export function castRefusal(members: CastMemberReq[]): string | null {
  if (members.length === 0) return "Tick the speakers you want to become Characters.";
  if (members.length > MAX_CAST_MEMBERS) {
    return `At most ${MAX_CAST_MEMBERS} Characters can be cast from one recording at a time.`;
  }
  const unnamed = members.filter((m) => !m.character);
  if (unnamed.length > 0) {
    return unnamed.length === 1
      ? `Name the Character for ${unnamed[0].speaker_id}.`
      : `Name every speaker you ticked — ${unnamed.length} still have no Character name.`;
  }
  const seen = new Map<string, string>();
  for (const m of members) {
    // `characterSlug` never answers "" — a name with no usable characters
    // becomes the literal "character" (lib/slugs mirrors voices.py::_slug), so
    // two unusable names collide here and are refused by the rule below rather
    // than by an unreachable branch of their own.
    const slug = characterSlug(m.character);
    const taken = seen.get(slug);
    if (taken) {
      return `“${taken}” and “${m.character}” would become the same Character (${slug}) — give them different names.`;
    }
    seen.set(slug, m.character);
  }
  return null;
}

/** How far through the cast the service is, for the progress screen. Counted
 *  from the members themselves, never from a total the browser assumed. */
export function castProgress(cast: CastJob | null | undefined): {
  total: number; settled: number; current: CastMember | null;
} {
  const members = cast?.members ?? [];
  const settled = members.filter((m) => m.status === "done" || m.status === "error").length;
  const current = members.find((m) => m.status === "labelling" || m.status === "cloning") ?? null;
  return { total: members.length, settled, current };
}

/** What one member is doing, in words. The service publishes the state; the
 *  studio must not invent a stage the pipeline does not have. */
export function memberStatusLabel(m: CastMember): string {
  switch (m.status) {
    case "pending": return "waiting its turn";
    case "labelling": return "finding this speaker’s emotions";
    case "cloning":
      return m.emotions_total
        ? `cloning voices · ${m.emotions_done ?? 0}/${m.emotions_total}`
        : "cloning voices";
    case "done": return `${(m.voices ?? []).length} voice(s) cloned`;
    case "error": return "not cast";
    default: return m.status;
  }
}

export type CastOutcome = {
  made: CastMember[];
  failed: CastMember[];
  voices: number;
  /** The one sentence the completion screen leads with. It states the partial
   *  case as a partial case — "2 of 3" is the whole point of this feature's
   *  honesty, and "2 characters ready" would be a lie by omission. */
  headline: string;
};

export function castOutcome(cast: CastJob | null | undefined): CastOutcome | null {
  const members = cast?.members ?? [];
  if (members.length === 0) return null;
  const made = members.filter((m) => m.status === "done");
  const failed = members.filter((m) => m.status === "error");
  const voices = made.reduce((n, m) => n + (m.voices ?? []).length, 0);
  const unreached = members.length - made.length - failed.length;
  let headline: string;
  if (made.length === 0) {
    headline = "No Character could be cast from this recording.";
  } else if (failed.length === 0 && unreached === 0) {
    headline = `${made.length} Character${made.length === 1 ? "" : "s"} cast · ${voices} voice${voices === 1 ? "" : "s"}.`;
  } else {
    headline = `${made.length} of ${members.length} Characters cast · ${voices} voice${voices === 1 ? "" : "s"}.`;
  }
  return { made, failed, voices, headline };
}
