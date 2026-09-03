"use client";

/*
 * THE LEADERBOARD BAR, DRAWN.
 *
 * RESTRAINED TIER, and the restraint is the point: /benchmarks is a
 * numbers-first page and the number beside every bar is the claim. Nothing here
 * touches it. What changed is the bar's ENTRANCE — it was a div that simply
 * existed; it is now a stroke that draws itself once, in the house verb
 * (<Draw>, dash-draw on `pathLength`), when the row scrolls into view.
 *
 * TO SCALE, FROM SOURCE. `pct` is computed by the caller from `lib/benchmarks.ts`
 * through the same `logWidth` the div used. This component does no arithmetic on
 * a cost and holds no figure; a re-measured run moves the geometry because the
 * geometry is the argument.
 *
 * ONE ACCENT: a Gravitone row is the point, so it keeps the cyan→emerald stroke.
 * An ElevenLabs row is the comparison, so it goes hairline — "everything that is
 * not the point stays hairline" is the colour law, and the price next to it is
 * doing the talking anyway.
 *
 * ONCE, ON VIEW. `useInView(once)` gates the mount, so the stroke draws exactly
 * one time per page open and never re-runs on a re-render. Where there is no
 * IntersectionObserver at all (jsdom, and any engine without it) the bar is
 * drawn immediately rather than never — an invisible bar would be a missing
 * datum, which is a worse failure than a missing animation.
 */

import { useEffect, useRef, useState } from "react";
import { Draw, HAIR, accentVar } from "@/components/variants/features/previews/illus";
import { useStillMotion } from "@/lib/useStillMotion";

/** Unique per row so two bars cannot share one gradient node. */
const gradId = (key: string) => `gt-costbar-${key.replace(/[^a-z0-9]+/gi, "-")}`;

export default function CostBar({
  pct,
  accent,
  rowKey,
}: {
  /** Bar length as a percentage of the track, from the caller's log scale. */
  pct: number;
  /** True for a measured Gravitone box — the row the page is about. */
  accent: boolean;
  rowKey: string;
}) {
  const still = useStillMotion();
  const ref = useRef<HTMLDivElement>(null);
  // Own observer rather than framer's `useInView`: that hook constructs an
  // IntersectionObserver in an effect unconditionally, so it throws outright
  // where there is none, which is the one case this bar must survive.
  const [drawn, setDrawn] = useState(() => typeof IntersectionObserver !== "function");
  useEffect(() => {
    if (drawn || !ref.current) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        setDrawn(true);   // `once`: the stroke draws one time per page open
        io.disconnect();
      },
      { rootMargin: "-40px" },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [drawn]);
  const id = gradId(rowKey);

  return (
    <div ref={ref} className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-white/5">
      <svg
        aria-hidden
        viewBox="0 0 100 2.5"
        preserveAspectRatio="none"
        className="block h-full w-full"
      >
        {accent && (
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={accentVar("cyan")} />
              <stop offset="100%" stopColor={accentVar("emerald")} />
            </linearGradient>
          </defs>
        )}
        {drawn && (
          <Draw
            d={`M0 1.25 H${pct}`}
            duration={0.85}
            stroke={accent ? `url(#${id})` : HAIR}
            width={2.5}
            still={still}
          />
        )}
      </svg>
    </div>
  );
}
