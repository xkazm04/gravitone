// What a turn becomes once the stage has it: the conversation's own turn, plus
// the audio it produced after it was banked as a take.

import type { ScriptLine } from "../_variants/playgroundHelpers";
import type { LiveTurn } from "./conversation";

export type Row = LiveTurn & { url?: string; seconds?: number };

/** The Character's colour on this stage — its avatar and its turn players. One
 *  derivation, so the dot and the waveform can never disagree. */
export const hueFor = (id: string) => (id.length * 47) % 360;

/** Hand the rehearsal to the Script composer: agent turns speak as the dialled
 *  Character, your own turns as the next Character in the roster. */
export function toScriptLines(rows: Row[], charId: string, otherCharId: string): ScriptLine[] {
  return rows
    .filter((r) => r.text.trim())
    .map((r, i) => ({
      id: `line-live-${r.id}-${i}`,
      characterId: r.role === "agent" ? charId : otherCharId,
      text: r.text.trim(),
    }));
}
