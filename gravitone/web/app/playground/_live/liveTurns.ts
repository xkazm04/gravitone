// What a turn becomes once the stage has it: the conversation's own turn, plus
// the audio it produced after it was banked as a take.

import type { ScriptLine } from "../_variants/playgroundHelpers";
import type { LiveStatus, LiveTurn } from "./conversation";

export type Row = LiveTurn & { url?: string; seconds?: number };

/** The Character's colour on this stage — its avatar and its turn players. One
 *  derivation, so the dot and the waveform can never disagree. */
export const hueFor = (id: string) => (id.length * 47) % 360;

/**
 * Who has the floor, in the words the stage says out loud.
 *
 * `speaking` is the conversation's own getter — audio actually SCHEDULED — so
 * this can never claim the agent is talking after it stopped. While it talks,
 * "listening" is the one thing the call is not doing, which is what this fixes.
 * Muted is still said over the top of it: the agent holding the floor does not
 * make the microphone live again, and dropping that would be the worse silence.
 */
export function floorLabel(
  { status, speaking, muted, hasRows }:
  { status: LiveStatus; speaking: boolean; muted: boolean; hasRows: boolean },
): string {
  if (status === "connecting") return "connecting…";
  if (status === "live") {
    if (speaking) return muted ? "muted · agent speaking" : "agent speaking";
    return muted ? "muted" : "listening";
  }
  return hasRows ? "call ended" : "";
}

/**
 * Put a turn into the transcript BY ID.
 *
 * The conversation announces one utterance more than once — an interim guess,
 * then the confirmed transcript — under a single id, and a duplicated frame
 * carries the id it already used. Appending would print the same sentence
 * twice; matching on id keeps the row in the position it was first heard in,
 * which is what makes the order survive a repeat.
 *
 * The existing row's derived fields (`url`, `seconds` — written later, once the
 * turn has been banked as a take) are kept: a re-announcement of a turn must not
 * silently unhook its player.
 */
export function upsertRow(rows: Row[], turn: LiveTurn): Row[] {
  const at = rows.findIndex((r) => r.id === turn.id);
  if (at === -1) return [...rows, turn];
  const next = rows.slice();
  next[at] = { ...rows[at], ...turn };
  return next;
}

/** Hand the rehearsal to the Script composer: agent turns speak as the dialled
 *  Character, your own turns as the next Character in the roster.
 *
 *  A row still marked `interim` is a guess the service never confirmed and never
 *  recorded; it is shown as a guess and it does not become a written line. */
export function toScriptLines(rows: Row[], charId: string, otherCharId: string): ScriptLine[] {
  return rows
    .filter((r) => !r.interim && r.text.trim())
    .map((r, i) => ({
      id: `line-live-${r.id}-${i}`,
      characterId: r.role === "agent" ? charId : otherCharId,
      text: r.text.trim(),
    }));
}
