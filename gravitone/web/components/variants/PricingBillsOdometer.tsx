"use client";

import { useEffect, useRef } from "react";
import { animate } from "framer-motion";
import { fmtUsd } from "@/lib/switchkit";
import { EASE } from "@/components/ui/tokens";
import { D_RUN, N, SERIES, T_RUN } from "./pricingBillsMath";

/* ── the odometers ─────────────────────────────────────────────────────────── */

/**
 * A running total, counting in MONTHLY STEPS.
 *
 * Stepped, not interpolated: a bill lands once a month, and a counter that
 * slides smoothly between two months is showing an amount neither party ever
 * charged. It writes through a ref rather than through state — sixty renders a
 * second of a whole landing section to move one number is not a trade worth
 * making — and the markup it ships with is the FINAL figure, so the server, a
 * stilled render and a failed animation all show a true total instead of a zero.
 */
export function Odometer({
  steps,
  still,
  className,
}: {
  steps: number[];
  still: boolean;
  className: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const final = fmtUsd(steps[steps.length - 1]);
  useEffect(() => {
    const node = ref.current;
    if (still || !node) return;
    node.textContent = fmtUsd(0);
    const controls = animate(0, steps.length, {
      delay: T_RUN,
      duration: D_RUN,
      ease: EASE,
      onUpdate: (m) => {
        const i = Math.min(steps.length, Math.max(1, Math.ceil(m))) - 1;
        node.textContent = m <= 0 ? fmtUsd(0) : fmtUsd(steps[i]);
      },
      onComplete: () => {
        node.textContent = final;
      },
    });
    return () => controls.stop();
    // `steps` is module-level and constant; re-running on `still` is the point.
  }, [still, steps, final]);
  return (
    <span ref={ref} className={className}>
      {final}
    </span>
  );
}

/** The step the odometer just took — theirs climbs the tiers, ours never moves. */
export function Increment({ still }: { still: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const final = `+${fmtUsd(SERIES[N - 1].el)} · ${SERIES[N - 1].tier.name}`;
  useEffect(() => {
    const node = ref.current;
    if (still || !node) return;
    const controls = animate(0, N, {
      delay: T_RUN,
      duration: D_RUN,
      ease: EASE,
      onUpdate: (m) => {
        const p = SERIES[Math.min(N, Math.max(1, Math.ceil(m))) - 1];
        node.textContent = `+${fmtUsd(p.el)} · ${p.tier.name}`;
      },
      onComplete: () => {
        node.textContent = final;
      },
    });
    return () => controls.stop();
  }, [still, final]);
  return <span ref={ref}>{final}</span>;
}
