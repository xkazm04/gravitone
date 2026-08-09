// The service's caps on a public fork, and the turn-by-turn reading of a take
// that decides whether the panel is a cast editor or one field.

import { castOf, type SharedTake } from "@/lib/takes";

/** The service's own cap (service/takes.py::MAX_REPERFORM_TEXT). Mirrored so
 *  the field can say so BEFORE a visitor spends a request finding out — the
 *  service is still the enforcer, and its "too-long" refusal is what shows if
 *  the two ever drift. It is a cap on the WHOLE re-performance: a cast fork of
 *  N lines gets the same budget a one-voice fork of the same length gets, so
 *  splitting the words across voices never buys more of this box's CPU. */
export const MAX_REPERFORM_TEXT = 1000;

/** The service's cap on how many voice lines one public fork may be split into
 *  (service/takes.py::MAX_REPERFORM_LINES). */
export const MAX_REPERFORM_LINES = 12;

/** One editable line of a CAST re-perform: whose voice, and what they say. */
export type CastLine = { characterId: string; name: string; text: string };

/**
 * The speaker turns a take offers for editing, in performance order.
 *
 * Empty when the take names fewer than two speakers — a solo take, and every
 * take published before segments carried a cast — which is what puts the panel
 * on its single-voice path.
 *
 * Consecutive segments of the SAME Character are one turn, with each
 * non-baseline segment re-wrapped in the `[emotion]` tag it was written with.
 * That is the round trip: the segments are what the tags COMPILED to, so
 * re-emitting them as tags hands the visitor back the line the publisher
 * actually typed rather than a de-tagged transcript of it.
 */
export function castLines(take: SharedTake): CastLine[] {
  if (castOf(take).size < 2) return []; // one voice (or none named) is not a cast
  const turns: CastLine[] = [];
  for (const s of take.segments) {
    if (!s.character_id) continue;
    const piece = s.requested && s.requested !== "baseline"
      ? `[${s.requested}]${s.text}[/${s.requested}]`
      : s.text;
    const last = turns[turns.length - 1];
    if (last && last.characterId === s.character_id) {
      last.text = `${last.text} ${piece}`.trim();
    } else {
      turns.push({
        characterId: s.character_id,
        name: s.character_name || s.character_id,
        text: piece,
      });
    }
  }
  return turns;
}
