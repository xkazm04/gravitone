"use client";

// The console's two read-only reads about WHO can speak: the roster, and the
// client-approved recommendation that decides which of them starts selected.

import { useEffect, useState } from "react";
import { apiJson } from "@/lib/apiFetch";
import type { useMounted } from "@/lib/useMounted";
import { isAbort } from "./playgroundEngine";
// ONE character-list data layer, shared with the voices module — the playground
// used to fetch /api/characters itself, so the app had two truths about the
// roster (and two places to fix when it went stale).
import { loadRoster, type Character } from "@/app/voices/_data/characters";

export function usePlaygroundRoster(mounted: ReturnType<typeof useMounted>) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [preferred, setPreferred] = useState<{ character_id: string | null; picks: number }>({ character_id: null, picks: 0 });

  const [rosterErr, setRosterErr] = useState<string | null>(null);
  useEffect(() => {
    // Two INDEPENDENT reads that used to be awaited one after the other, so the
    // rail waited for a recommendation it does not depend on. They are started
    // together now, and a real AbortController (not just an `alive` flag) means
    // navigating away actually cancels them instead of leaving the requests to
    // finish for a page nobody is looking at.
    const ctrl = new AbortController();
    // The roster goes through the shared data layer; the recommendation is
    // decoration, so its failure degrades to "no recommendation" and never
    // costs the user the rail.
    const rosterP = loadRoster(ctrl.signal);
    const prefP = apiJson<{ character_id: string | null; picks: number }>(
      "/api/reviews/preferred", { cache: "no-store", signal: ctrl.signal }, "no recommendation")
      .catch(() => ({ character_id: null, picks: 0 }));
    (async () => {
      try {
        const [cs, pref] = [await rosterP, await prefP];
        if (!mounted.current || ctrl.signal.aborted) return;
        setCharacters(cs);
        setPreferred(pref);
        setRosterErr(null);
        // Which Character is selected is decided in ONE place below — it now
        // has to reconcile a restored selection against the live roster.
      } catch (e) {
        // An abort is this component going away, not a failed read.
        if (!mounted.current || isAbort(e) || ctrl.signal.aborted) return;
        setCharacters([]);
        setRosterErr(e instanceof Error ? e.message : "could not load characters");
      }
    })();
    return () => ctrl.abort();
  }, [mounted]);

  return { characters, preferred, rosterErr };
}
