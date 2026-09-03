"use client";

// Who is available to read, and who the listener picked. Both are deferred
// until the dock is actually expanded: a landing page must not spend a request
// on a roster nobody asked to see.

import { useCallback, useEffect, useState } from "react";

import { readDetail } from "@/lib/apiFetch";
import { AUTO_NARRATOR, NARRATOR_KEY, type Narrator } from "./narrationDockNarrator";

export function useNarrationDockNarrators(open: boolean) {
  const [roster, setRoster] = useState<Narrator[] | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string>(AUTO_NARRATOR);

  // ── narrator persistence (client-only; never read during render) ───────────
  useEffect(() => {
    try {
      const saved = localStorage.getItem(NARRATOR_KEY);
      if (saved) setChosen(saved);
    } catch {
      /* storage blocked — the picker still works, it just will not be remembered */
    }
  }, []);
  const chooseNarrator = useCallback((id: string) => {
    setChosen(id);
    try {
      localStorage.setItem(NARRATOR_KEY, id);
    } catch {
      /* not remembered; nothing else changes */
    }
  }, []);

  // ── the roster, fetched on first expand (never on page load) ───────────────
  useEffect(() => {
    if (!open || roster || rosterError) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/characters", { cache: "no-store", signal: ctrl.signal });
        if (!res.ok) {
          const detail = await readDetail(res);
          throw new Error(detail ?? "could not load the narrators");
        }
        const list = (await res.json()) as Narrator[];
        const usable = Array.isArray(list) ? list.filter((c) => c?.character_id) : [];
        if (ctrl.signal.aborted) return;
        if (!usable.length) {
          setRosterError("this deployment has no Characters to read with yet");
          return;
        }
        setRoster(usable);
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
        setRosterError((e as Error).message || "could not load the narrators");
      }
    })();
    return () => ctrl.abort();
  }, [open, roster, rosterError]);

  return { roster, rosterError, chosen, chooseNarrator };
}
