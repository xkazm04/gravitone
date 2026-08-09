"use client";

import { clamp01 } from "./trackHelpers";

/**
 * The position line. Drawn only when the caller says there is a position to
 * draw — a line parked at 0 on every idle rail reads as a claim about where
 * playback is, which is the same lie the CSS-timer equalizer used to tell.
 */
export function Playhead({ progress, hue = 190 }: { progress: number; hue?: number }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 z-20 w-px transition-[left] duration-75 ease-linear"
      style={{
        left: `${clamp01(progress) * 100}%`,
        background: `hsl(${hue} 90% 78%)`,
        boxShadow: `0 0 6px hsl(${hue} 90% 70% / 0.8)`,
      }}
    />
  );
}
