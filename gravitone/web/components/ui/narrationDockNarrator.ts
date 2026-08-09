// ── narrator selection ───────────────────────────────────────────────────────

import type { CharacterHint } from "@/lib/narratable";

/** The slice of /api/characters this dock needs. Typed locally rather than
 *  imported from app/voices/_data — that module is the studio's data layer and
 *  drags Firebase auth in with it, which a public landing page must not load. */
export type Narrator = {
  character_id: string;
  name: string;
  category?: "cloned" | "premade";
  tags?: string[];
  lang?: string;
};

export const NARRATOR_KEY = "gravitone.narrator";
export const AUTO_NARRATOR = "auto";

const HINT_MATCH: Record<CharacterHint, RegExp> = {
  warm: /warm|bright|friendly|happy|soft/i,
  measured: /narration|calm|neutral|deep|documentary|measured/i,
};

/**
 * Who reads this block.
 *
 * An explicit choice wins everywhere — a listener who picked a narrator gets
 * that narrator, not a per-section surprise. On "auto" the section's
 * characterHint picks from the roster's own tags (hero = warm, benchmarks =
 * measured), and when nothing matches the first roster entry reads it. Never
 * invents an id: an empty roster returns null and the dock refuses to play with
 * a named reason instead of posting a guess at the relay.
 */
export function pickNarrator(
  roster: Narrator[],
  chosen: string,
  hint: CharacterHint,
): Narrator | null {
  if (!roster.length) return null;
  if (chosen !== AUTO_NARRATOR) {
    const exact = roster.find((c) => c.character_id === chosen);
    if (exact) return exact;
  }
  const re = HINT_MATCH[hint];
  const tagged = roster.find((c) => (c.tags ?? []).some((t) => re.test(t)) || re.test(c.name));
  return tagged ?? roster.find((c) => c.category === "premade") ?? roster[0];
}
