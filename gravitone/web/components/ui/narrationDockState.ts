// ── the state machine ────────────────────────────────────────────────────────
//
// Exported and pure, because the interesting bugs in a transport are all
// transition bugs: ending the last sentence must return to a resettable idle,
// collapsing must NOT stop the voice mid-word, a failure must keep its place so
// "play" retries the sentence that failed rather than restarting the page.

export type DockPhase = "idle" | "loading" | "playing" | "paused" | "error";

export type DockState = {
  /** Expanded transport (true) vs collapsed pill (false). */
  open: boolean;
  phase: DockPhase;
  /** Cursor into the flattened sentence plan. */
  index: number;
  /** The named reason for `phase === "error"`. */
  error: string | null;
};

export const INITIAL_DOCK: DockState = { open: false, phase: "idle", index: 0, error: null };

export type DockEvent =
  | { t: "arm" }                     // ?narrate=1 — open, do NOT play
  | { t: "expand" }
  | { t: "collapse" }                // collapse only: audio keeps playing
  | { t: "play" }                    // start / retry at the current index
  | { t: "pause" }
  | { t: "resume" }
  | { t: "started" }                 // the element is actually producing audio
  | { t: "ended"; total: number }
  | { t: "next"; total: number }
  | { t: "prev" }
  | { t: "jump"; index: number }
  | { t: "stop" }
  | { t: "fail"; message: string };

export function reduceDock(s: DockState, e: DockEvent): DockState {
  switch (e.t) {
    case "arm":
      // Armed is OPEN, never PLAYING. The whole deep link is one click short of
      // audio on purpose.
      return s.open ? s : { ...s, open: true };
    case "expand":
      return { ...s, open: true };
    case "collapse":
      return { ...s, open: false };
    case "play":
      return { ...s, phase: "loading", error: null };
    case "pause":
      return s.phase === "playing" || s.phase === "loading" ? { ...s, phase: "paused" } : s;
    case "resume":
      return s.phase === "paused" ? { ...s, phase: "playing", error: null } : s;
    case "started":
      return s.phase === "loading" || s.phase === "playing" ? { ...s, phase: "playing" } : s;
    case "ended":
      return s.index + 1 < e.total
        ? { ...s, phase: "loading", index: s.index + 1, error: null }
        : { ...s, phase: "idle", index: 0, error: null };
    case "next":
      return s.index + 1 < e.total
        ? { ...s, phase: "loading", index: s.index + 1, error: null }
        : { ...s, phase: "idle", index: 0, error: null };
    case "prev":
      return { ...s, phase: "loading", index: Math.max(0, s.index - 1), error: null };
    case "jump":
      return { ...s, phase: "loading", index: Math.max(0, e.index), error: null };
    case "stop":
      return { ...s, phase: "idle", index: 0, error: null };
    case "fail":
      // The index is KEPT: pressing play retries the sentence that failed.
      return { ...s, phase: "error", error: e.message };
    default:
      return s;
  }
}
