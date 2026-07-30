// The Audition Room's pure logic: how a blind comparison of candidate takes is
// run, and what a vote means for the commit.
//
// Kept out of the component on purpose — "which take did the user's ear pick"
// is a correctness question (it decides what gets cloned), so it is testable
// without rendering anything.

import type { Recipe, Stem } from "./machine";

/** The default splice — what the ledger row already reports, and what commits
 *  when nobody auditions anything. */
export function defaultRecipe(stem: Stem): Recipe | null {
  const rs = stem.recipes ?? [];
  return rs.find((r) => r.default) ?? rs[0] ?? null;
}

/** The candidate takes worth comparing. Fewer than two = no comparison exists,
 *  and the drill-down is not offered at all (absent = invisible). */
export function candidates(stem: Stem): Recipe[] {
  const rs = stem.recipes ?? [];
  return rs.length >= 2 ? rs : [];
}

export function recipeById(stem: Stem, id: string | undefined): Recipe | null {
  if (!id) return null;
  return (stem.recipes ?? []).find((r) => r.id === id) ?? null;
}

/**
 * A best-of ladder over the candidates: the current winner is carried forward
 * and challenged by the next take, one pair at a time.
 *
 * `x`/`y` are deliberately UNLABELLED in the UI — the vote is "which of these
 * two sounds more like the speaker", and knowing which one is "the longest
 * takes" is exactly the bias the comparison exists to remove. The incumbent
 * swaps sides on odd rounds so a user who always clicks the left player is not
 * silently voting for the same take twice.
 *
 * Deterministic (no randomness): the same candidates always produce the same
 * pairs, so the ladder is testable and cannot differ between server and client
 * render.
 */
export type Ladder = {
  round: number;
  x: Recipe | null;
  y: Recipe | null;
  queue: Recipe[];       // challengers not yet heard
  winner: Recipe | null; // the take currently ahead
  lastPick: Recipe | null;
  done: boolean;
};

function pair(round: number, winner: Recipe, queue: Recipe[], lastPick: Recipe | null): Ladder {
  const challenger = queue[0] ?? null;
  if (!challenger) {
    return { round, x: null, y: null, queue: [], winner, lastPick, done: true };
  }
  const swap = round % 2 === 1;
  return {
    round,
    x: swap ? challenger : winner,
    y: swap ? winner : challenger,
    queue: queue.slice(1),
    winner,
    lastPick,
    done: false,
  };
}

export function startLadder(recipes: Recipe[]): Ladder {
  if (recipes.length < 2) {
    return { round: 0, x: null, y: null, queue: [], winner: recipes[0] ?? null,
      lastPick: null, done: true };
  }
  return pair(0, recipes[0], recipes.slice(1), null);
}

export function vote(ladder: Ladder, side: "x" | "y"): Ladder {
  const picked = side === "x" ? ladder.x : ladder.y;
  if (!picked || ladder.done) return ladder;
  return pair(ladder.round + 1, picked, ladder.queue, picked);
}

/**
 * The `recipes` map a commit carries: every KEPT emotion whose winner is not the
 * default splice. Emotions that were descoped, never auditioned, or auditioned
 * back to the default contribute nothing — so the fast path sends no map at all
 * and the request is byte-identical to what it was before this feature existed.
 */
export function commitRecipes(
  auditions: Record<string, string>,
  selected: Set<string>,
  stems: Stem[],
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const stem of stems) {
    if (!selected.has(stem.emotion)) continue;
    const chosen = recipeById(stem, auditions[stem.emotion]);
    // A recipe the backend no longer offers is not sent: it would be refused and
    // reported as skipped, which is a worse outcome than never claiming it.
    if (!chosen || chosen.default) continue;
    out[stem.emotion] = chosen.id;
  }
  return Object.keys(out).length ? out : undefined;
}
