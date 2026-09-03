"use client";

// ── the /v1/narrate consumer ─────────────────────────────────────────────────
//
// The registry above narrates THIS site. `?narration=<id>` narrates anything
// else: a plan minted by POST /v1/narrate — a customer's docs page, a pasted
// README, a blog post — played by the same transport, with the same cache, the
// same keyboard rules and the same refusals. That is the whole point of the
// plan being data: one player, two sources.
//
// The id travels in the URL rather than in a prop because the interesting use
// is a LINK ("here, listen to this"), and a link cannot pass a prop.

import { useEffect, useState } from "react";

import { readDetail } from "@/lib/apiFetch";
import { routeFromPlan, type NarratableRoute } from "@/lib/narratable";

const NARRATION_PARAM = "narration";
const NARRATION_ID = /^[a-z0-9]{1,32}$/i;

export type RemoteNarration = {
  route: NarratableRoute | null;
  notice: string | null;
  loading: boolean;
  requested: boolean;
};

export function useRemoteNarration(): RemoteNarration {
  const [state, setState] = useState<RemoteNarration>(
    { route: null, notice: null, loading: false, requested: false });

  useEffect(() => {
    let id = "";
    try {
      id = new URLSearchParams(window.location.search).get(NARRATION_PARAM) ?? "";
    } catch {
      return; // exotic URL — the registry dock is unaffected
    }
    if (!id) return;
    if (!NARRATION_ID.test(id)) {
      setState({ route: null, loading: false, requested: true,
                 notice: "that narration id is not a valid id" });
      return;
    }
    const ctrl = new AbortController();
    setState({ route: null, notice: null, loading: true, requested: true });
    (async () => {
      try {
        const res = await fetch(`/api/narrate/${id}`, { signal: ctrl.signal, cache: "no-store" });
        if (res.status === 404) {
          // Two different 404s, and the difference matters to whoever is
          // debugging: no relay route deployed vs. a plan that has aged out.
          const detail = await readDetail(res);
          throw new Error(detail
            ?? "that narration is not on this deployment — plans are evicted oldest-first");
        }
        if (!res.ok) throw new Error(await readDetail(res) ?? "that narration could not be loaded");
        const built = routeFromPlan(await res.json());
        if (ctrl.signal.aborted) return;
        if (!built) throw new Error("that narration plan contains nothing readable");
        setState({ route: built, notice: null, loading: false, requested: true });
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
        setState({
          route: null, loading: false, requested: true,
          notice: (e as Error).message || "that narration could not be loaded",
        });
      }
    })();
    return () => ctrl.abort();
  }, []);

  return state;
}

/** The stand-in reading for a narration that could not be loaded. The dock
 *  still appears, because the visitor followed a link that promised audio and
 *  silence is not an answer — it appears saying exactly what went wrong. */
export const EMPTY_ROUTE: NarratableRoute = {
  route: "narration:unavailable",
  title: "This narration could not be loaded",
  blocks: [],
};
