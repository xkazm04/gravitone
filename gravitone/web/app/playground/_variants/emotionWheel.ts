// The wheel's geometry — how big it may be, and when it stops being able to
// afford a label under every spoke.

/** The wheel at its most generous — the size it was hard-coded at, now a
 *  ceiling rather than a demand. */
export const MAX_BOX = 440;
/** Below this the wheel is still a wheel, but the spokes shrink to a 44px
 *  touch target and their status lines move to the hub (which is the only
 *  place there is room for a sentence). */
export const COMPACT_BELOW = 380;
/** Half a spoke, so the ring can be inset far enough that no spoke crosses the
 *  panel edge. Compact spokes are w-16 with a 44px disc; full ones are w-24
 *  with a 64px disc, plus a label line under each. */
export const SPOKE_REACH = { compact: 34, full: 52 };

/**
 * How big the wheel can be right now.
 *
 * It used to be `h-[440px] w-[440px]` with `R = 150`, which overflows every
 * phone in existence — the control that teaches this product's best idea was
 * unusable on the device most people would first meet it on. The box is
 * measured against BOTH axes because a wheel that fits the width and runs off
 * the bottom is equally unreachable.
 */
export function wheelBox(w: number, h: number): number {
  return Math.max(240, Math.min(MAX_BOX, w - 64, h - 240));
}
