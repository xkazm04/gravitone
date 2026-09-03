"use client";

import type { Character } from "../_data/characters";

export type SortKey = "name" | "category" | "lang" | "coverage" | "weakest" | "demand" | "created";

/** Unmet demand for a Character: total requests over its STILL-MISSING emotions
 *  (a slot already recorded isn't unmet), plus the hottest missing slot to
 *  record next. The backend already prunes recorded slots from `demand`; we
 *  re-filter defensively so the number can never count a filled emotion. */
export function unmetDemand(c: Character): { total: number; hottest: string | null } {
  let total = 0;
  let hottest: string | null = null;
  let max = 0;
  for (const [emotion, n] of Object.entries(c.demand ?? {})) {
    if (c.emotions.includes(emotion)) continue; // recorded → met, not unmet
    total += n;
    if (n > max) { max = n; hottest = emotion; }
  }
  return { total, hottest };
}

/** Run `task` over `items` with at most `limit` in flight; collects failures. */
export async function runPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<Error[]> {
  const errors: Error[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try { await task(item); }
      catch (e) { errors.push(e instanceof Error ? e : new Error(String(e))); }
    }
  });
  await Promise.all(workers);
  return errors;
}
