"use client";

// The rail's interaction layer: click, drag and keyboard, all resolving to the
// one thing <Track> hands back — a fraction of the rail.

import type { KeyboardEvent, PointerEvent } from "react";
import { useRef } from "react";
import { PAGE, STEP, clamp01 } from "./trackHelpers";

export function useTrackSeek(at: number, onSeek?: (fraction: number) => void) {
  const railRef = useRef<HTMLDivElement>(null);

  /** Where in the rail (0..1) a client x coordinate falls. */
  const fractionAt = (clientX: number): number => {
    const box = railRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return 0;
    return clamp01((clientX - box.left) / box.width);
  };

  const seekBy = (delta: number) => onSeek?.(clamp01(at + delta));

  // Scrubbing. A rail that only takes discrete clicks is a rail you cannot
  // sweep, and sweeping is how anyone finds a moment in a clip. Pointer capture
  // keeps the drag alive past the rail's own edges.
  const scrubbing = useRef(false);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (!onSeek || e.button !== 0) return;
    scrubbing.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onSeek(fractionAt(e.clientX));
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!scrubbing.current || !onSeek) return;
    onSeek(fractionAt(e.clientX));
  }

  function endScrub(e: PointerEvent<HTMLDivElement>) {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!onSeek) return;
    const move =
      e.key === "ArrowRight" || e.key === "ArrowUp" ? STEP
      : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -STEP
      : e.key === "PageUp" ? PAGE
      : e.key === "PageDown" ? -PAGE
      : 0;
    if (move !== 0) {
      e.preventDefault();
      seekBy(move);
      return;
    }
    if (e.key === "Home") { e.preventDefault(); onSeek(0); }
    else if (e.key === "End") { e.preventDefault(); onSeek(1); }
  }

  return { railRef, fractionAt, onPointerDown, onPointerMove, endScrub, onKeyDown };
}
