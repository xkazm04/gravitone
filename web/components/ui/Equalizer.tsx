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

/** Live equalizer bars. Shared by the landing hero and the on-page sections;
 *  animation pauses automatically when the bars scroll off-screen. */
export default function Equalizer({ bars = 28, className = "" }: { bars?: number; className?: string }) {
  const { ref, paused } = usePauseOffscreen<HTMLDivElement>();
  return (
    <div ref={ref} className={`flex items-end gap-[3px] ${paused ? "anim-paused" : ""} ${className}`} aria-hidden>
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className="eq-bar w-[3px] rounded-full bg-gradient-to-t from-cyan-400/40 to-cyan-200"
          style={{ height: 40, animationDelay: `${(i % 9) * 0.09}s`, animationDuration: `${0.9 + (i % 5) * 0.12}s` }}
        />
      ))}
    </div>
  );
}
