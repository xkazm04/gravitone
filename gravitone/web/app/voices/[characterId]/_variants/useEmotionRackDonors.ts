"use client";

import { useCallback, useState } from "react";
import { loadRoster } from "@/app/voices/_data/characters";

// ── donors ────────────────────────────────────────────────────────────────────
// Emotion Algebra can take its direction from ONE named speaker's take. The
// candidates are simply every other Character that has RECORDED this emotion —
// derived takes are excluded because deriving from a derived voice compounds the
// approximation (the service refuses it too, and offering a button that always
// 422s is worse than not offering it).
//
// Loaded LAZILY, on the first time somebody opens the picker: the rack is the
// page's main view and most visits never derive anything, so this must not become
// a second roster fetch on every mount.
export type Donor = { characterId: string; name: string; emotions: string[] };

export function useEmotionRackDonors(selfId: string) {
  const [donors, setDonors] = useState<Donor[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (donors || loading) return;
    setLoading(true);
    setError(null);
    try {
      const roster = await loadRoster();
      setDonors(roster
        .filter((c) => c.character_id !== selfId)
        .map((c) => ({
          characterId: c.character_id,
          name: c.name,
          emotions: c.voices.filter((v) => v.origin !== "derived").map((v) => v.emotion),
        }))
        .filter((d) => d.emotions.length > 0));
    } catch (e) {
      // Named: "no donors" and "the roster could not be read" are different
      // things, and only one of them means recording is the way forward.
      setError(e instanceof Error ? e.message : "the roster could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [donors, loading, selfId]);

  return { donors, loading, error, load };
}

/** The lazily-loaded donor pool as the rack and its picker both see it. */
export type DonorPool = ReturnType<typeof useEmotionRackDonors>;
