/*
 * The pricing band's one piece of pure curve arithmetic, kept out of
 * ./pricingShared.tsx so that file is only the band's non-picture COMPONENTS.
 * ./pricingShared.tsx still re-exports it — it is the same shared helper, at
 * the same import site as before.
 */

import { EASE } from "@/components/ui/tokens";

/**
 * The TIME at which an eased sweep has reached a given fraction of its path.
 *
 * Both directions mark a specific month on a stroke that draws itself, and a
 * marker placed at the linear fraction of the duration lands nowhere near it:
 * EASE is a strong ease-out, so a fifth of the way through the clock the stroke
 * is already past half the path. This inverts the curve (bisection on the
 * cubic-bezier — exact enough for 24 steps) so a node lands on the month it is
 * naming. Pure, and shared, because two pictures getting this subtly different
 * would be worse than either getting it wrong.
 */
export function easedTimeFor(progress: number): number {
  const [x1, y1, x2, y2] = EASE;
  const bez = (a: number, b: number, t: number) =>
    3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bez(y1, y2, mid) < progress) lo = mid;
    else hi = mid;
  }
  return bez(x1, x2, (lo + hi) / 2);
}
