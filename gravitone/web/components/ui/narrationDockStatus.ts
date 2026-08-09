// Rule 2 of the dock — HONEST STATES — as one pure function. Every sentence the
// transport can say about itself is decided here, from facts only, so the copy
// can never drift out of agreement with the state machine that produced them.

import type { BakeManifest } from "@/lib/narratable";
import { cacheAvailable } from "@/lib/narrationCache";
import type { Narrator } from "./narrationDockNarrator";
import type { DockState } from "./narrationDockState";
import type { ClipSource } from "./narrationDockSynthesis";

export const SOURCE_COPY: Record<ClipSource, string> = {
  cache: "playing — cached",
  baked: "playing — baked at build time",
  live: "playing — rendered just now",
};

export function dockStatus({
  state, notice, rosterError, total, roster, source, manifest, cached, bakeUnserved,
}: {
  state: DockState;
  /** A remote plan that would not load, from ?narration=<id>. */
  notice: string | null | undefined;
  rosterError: string | null;
  total: number;
  roster: Narrator[] | null;
  source: ClipSource;
  manifest: BakeManifest | null;
  cached: number;
  /** A clip the manifest promised did not arrive (useNarrationDockClips). */
  bakeUnserved?: boolean;
}): string {
  if (state.phase === "error") return state.error ?? "narration failed";
  // A remote plan that failed to load is the FIRST thing to say: the visitor
  // followed a link that promised this specific reading.
  if (notice) return notice;
  if (rosterError) return rosterError;
  if (!total) return "there is nothing to read here";
  if (!roster && state.open) return "loading narrators…";
  // While LOADING, `source` still describes the sentence that just finished —
  // so it says nothing about this one. Claiming "cued" off a stale flag would
  // be the dock's one small lie.
  if (state.phase === "loading") return "cueing this sentence…";
  if (state.phase === "playing") return SOURCE_COPY[source];
  if (state.phase === "paused") return "paused";
  // Stated BEFORE the cache warning, and instead of it: "every listen
  // re-renders" is simply false on a baked page, and a warning that is false
  // is worse than no warning.
  // A bake this deployment cannot actually serve: the reading is unaffected
  // (live synthesis covers it) so there is no banner and no alarm — but the
  // "costs no engine" sentence below is now FALSE, and repeating it would be
  // the dock telling the visitor something it has already disproved.
  if (manifest && bakeUnserved) {
    return "ready — this page's baked audio is not being served here, so each listen renders live";
  }
  if (manifest) {
    return `ready — this page was baked with ${manifest.character_name}, so it costs no engine`;
  }
  if (!cacheAvailable()) return "ready — this browser cannot cache audio, every listen re-renders";
  return cached > 0 ? `ready — ${cached} sentence${cached === 1 ? "" : "s"} cached` : "ready when you are";
}
