"use client";

// ── controls ───────────────────────────────────────────────────────────────
// Rule 3 of the dock — KEYBOARD FIRST — in one place: the play/pause semantics
// the transport button and the space bar share, and the shortcuts that are live
// while focus is anywhere inside the dock.

import { useCallback, type Dispatch, type KeyboardEvent, type RefObject } from "react";

import type { DockEvent, DockPhase } from "./narrationDockState";

export function useNarrationDockTransport({
  phase, open, total, dispatch, audioRef, toggleOpen,
}: {
  phase: DockPhase;
  open: boolean;
  total: number;
  dispatch: Dispatch<DockEvent>;
  audioRef: RefObject<HTMLAudioElement | null>;
  toggleOpen: (open: boolean) => void;
}) {
  const onPlayPause = useCallback(() => {
    if (phase === "playing") {
      dispatch({ t: "pause" });
      return;
    }
    if (phase === "paused") {
      const el = audioRef.current;
      dispatch({ t: "resume" });
      void Promise.resolve(el?.play?.()).catch(() =>
        dispatch({ t: "fail", message: "the browser blocked playback — press play once more" }));
      return;
    }
    dispatch({ t: "play" });
  }, [phase, dispatch, audioRef]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Never steal a key from the narrator picker or a link inside the dock.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "SELECT" || tag === "INPUT" || tag === "A") return;
      switch (e.key) {
        case " ":
          // Space on a focused button MUST activate that button — hijacking it
          // for play/pause would make "next sentence" silently do something
          // else for anyone driving the transport from the keyboard.
          if (tag === "BUTTON") return;
          onPlayPause();
          break;
        case "k":
          onPlayPause();
          break;
        case "ArrowRight":
          dispatch({ t: "next", total });
          break;
        case "ArrowLeft":
          dispatch({ t: "prev" });
          break;
        case "Escape":
          if (open) toggleOpen(false);
          break;
        default:
          return;
      }
      e.preventDefault();
    },
    [onPlayPause, open, toggleOpen, total, dispatch],
  );

  return { onPlayPause, onKeyDown };
}
