"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Pause CSS animations while an element is scrolled off-viewport, so the
 * aurora / equalizer / grain loops don't burn CPU when nobody can see them.
 * Returns a ref to attach and a `paused` flag; the caller adds `anim-paused`
 * (globals.css) which sets `animation-play-state: paused` on the node and its
 * descendants. Reduced-motion is unaffected — those animations are already
 * disabled globally, so pausing them is a no-op.
 */
export function usePauseOffscreen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "80px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, paused: !visible };
}

export type BarColor = "cyan" | "violet" | "emerald";

const GRAD: Record<BarColor, string> = {
  cyan: "from-cyan-400/40 to-cyan-200",
  violet: "from-violet-400/40 to-violet-200",
  emerald: "from-emerald-400/40 to-emerald-200",
};

/**
 * The shared bar field behind both <Equalizer> and <Primitives.Waveform> —
 * previously two copies of the same markup that had already drifted.
 *
 * Two modes, one DOM:
 *  • no audio registered → the CSS keyframe (`.eq-bar`) runs, exactly as before,
 *    with the same per-bar delay/duration offsets. Idle decoration is preserved.
 *  • a source registered on the AudioBus → `[data-gt-live="1"] .eq-bar` in
 *    globals.css cancels the keyframe and drives scaleY() from --gt-level /
 *    --gt-peak / --gt-centroid instead. The bars stop lying.
 *
 * `--gt-bar-lo` / `--gt-bar-hi` are this bar's share of the low band (raw
 * loudness) and the high band (loudness × brightness), so a bright voice lifts
 * the right of the field and a dark one the left. Reduced motion is handled at
 * the bus (static peak, no oscillation), so there is nothing to branch on here.
 */
export function EqBars({
  bars = 28,
  color = "cyan",
  height = "100%",
}: {
  bars?: number;
  color?: BarColor;
  height?: number | string;
}) {
  return (
    <>
      {Array.from({ length: bars }).map((_, i) => {
        const band = bars > 1 ? i / (bars - 1) : 0;
        return (
          <span
            key={i}
            className={`eq-bar w-[3px] rounded-full bg-gradient-to-t ${GRAD[color]}`}
            style={
              {
                height,
                animationDelay: `${(i % 9) * 0.09}s`,
                animationDuration: `${0.9 + (i % 5) * 0.12}s`,
                "--gt-bar-lo": (0.95 - band * 0.55 + (i % 5) * 0.03).toFixed(3),
                "--gt-bar-hi": (0.25 + band * 0.85 + (i % 3) * 0.04).toFixed(3),
              } as React.CSSProperties
            }
          />
        );
      })}
    </>
  );
}

/** Live equalizer bars. Shared by the landing hero and the on-page sections;
 *  animation pauses automatically when the bars scroll off-screen. */
export default function Equalizer({ bars = 28, className = "" }: { bars?: number; className?: string }) {
  const { ref, paused } = usePauseOffscreen<HTMLDivElement>();
  return (
    <div ref={ref} className={`flex items-end gap-[3px] ${paused ? "anim-paused" : ""} ${className}`} aria-hidden>
      <EqBars bars={bars} height={40} />
    </div>
  );
}
