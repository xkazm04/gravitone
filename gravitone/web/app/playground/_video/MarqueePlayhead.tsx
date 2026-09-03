"use client";

import { useEffect, useState } from "react";

/** The one thing on this surface that moves with the video, isolated so the
 *  ribbon's N blocks do not re-render four times a second (the same discipline
 *  as the console's LiveProgress). */
export default function MarqueePlayhead({ videoRef, total }: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  total: number;
}) {
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setAt(v.currentTime);
    const onEnd = () => setAt(null);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", onEnd);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("ended", onEnd);
    };
  }, [videoRef]);
  if (at === null) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 w-px bg-cyan-300 shadow-[0_0_8px_var(--gt-glow-cyan)]"
      style={{ left: `${Math.min(100, (at / total) * 100)}%` }}
    />
  );
}
