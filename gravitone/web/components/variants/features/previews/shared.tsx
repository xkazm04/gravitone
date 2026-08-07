"use client";

/*
 * Shared vocabulary for the eight feature spotlights.
 *
 * Each preview is a small animated diagram of the mechanism its card claims —
 * a request card whose base URL flips, a waveform splitting into speaker lanes,
 * a socket taking turns. They all share the same two entrances and the same
 * "row" / "chip" shapes, so those live here once instead of being retyped eight
 * times.
 *
 * The idiom is this studio's, not a sticker sheet's: hairline borders, glass
 * over ink, cyan/violet/emerald accents from the tokens. Nothing here declares
 * a colour literal — surfaces come from `.glass-panel` and Tailwind alphas,
 * accents from the `--gt-accent-*` vars (see components/ui/tokens.ts, the one
 * file in web/ allowed to hold a hex).
 *
 * MOTION AUSTERITY. Every entrance below is entry-only: a spring or a tween
 * that settles and stops. Nothing loops, because a spotlight is opened
 * deliberately and then read. Reduced motion is handled by the spotlight frame
 * (useStillMotion) — these helpers take `still` and return a target that is
 * already at rest, so the elements are all still THERE. Dropping an element
 * under reduced motion is what breaks hydration; stopping it is what was asked
 * for.
 */
import type { ReactNode } from "react";
import { motion } from "framer-motion";

export type Accent = "cyan" | "violet" | "emerald";

/** The CSS var behind an accent name, for inline SVG strokes and glows. */
export const accentVar = (a: Accent) => `var(--gt-accent-${a})`;

/** Pop in — the default entrance for a line of copy, a chip, a card. */
export const pop = (delay: number, still = false) =>
  still
    ? { initial: { opacity: 1, scale: 1, y: 0 }, animate: { opacity: 1, scale: 1, y: 0 } }
    : {
        initial: { opacity: 0, scale: 0.82, y: 10 },
        animate: { opacity: 1, scale: 1, y: 0 },
        transition: { delay, type: "spring" as const, bounce: 0.34, duration: 0.5 },
      };

/** Land hard and settle — for anything that reads as a stamp or a verdict. */
export const stamp = (delay: number, still = false) =>
  still
    ? { initial: { opacity: 1, scale: 1 }, animate: { opacity: 1, scale: 1 } }
    : {
        initial: { opacity: 0, scale: 1.9 },
        animate: { opacity: 1, scale: 1 },
        transition: { delay, type: "spring" as const, bounce: 0.42, duration: 0.55 },
      };

/** A left-to-right sweep — for a span painted over text, or a signal arriving. */
export const sweep = (delay: number, still = false) =>
  still
    ? { initial: { scaleX: 1, opacity: 1 }, animate: { scaleX: 1, opacity: 1 } }
    : {
        initial: { scaleX: 0, opacity: 0.4 },
        animate: { scaleX: 1, opacity: 1 },
        transition: { delay, duration: 0.42, ease: [0.22, 1, 0.36, 1] as const },
      };

/** The panel every preview row is built from. */
export const ROW = "rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2";

/** Monospace micro-label — the studio's voice for anything machine-shaped. */
export const MONO = "font-jetbrains text-[11px] tracking-wide";

/** A small accent pill. Identity is the text; the colour only reinforces it. */
export function Chip({
  children,
  accent = "cyan",
  delay = 0.2,
  still,
}: {
  children: ReactNode;
  accent?: Accent;
  delay?: number;
  still?: boolean;
}) {
  return (
    <motion.span
      {...pop(delay, still)}
      className={`${MONO} inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1`}
      style={{
        borderColor: `color-mix(in srgb, ${accentVar(accent)} 40%, transparent)`,
        background: `color-mix(in srgb, ${accentVar(accent)} 10%, transparent)`,
        color: accentVar(accent),
      }}
    >
      {children}
    </motion.span>
  );
}

/** The closing line under a diagram — what the reader should take away. */
export function PreviewNote({
  children,
  delay = 1,
  still,
}: {
  children: ReactNode;
  delay?: number;
  still?: boolean;
}) {
  return (
    <motion.p {...pop(delay, still)} className="mt-4 text-[13px] leading-relaxed text-slate-300/80">
      {children}
    </motion.p>
  );
}

/** The full-width confirmation bar several previews end on. */
export function ConfirmBar({
  children,
  accent = "emerald",
  delay = 1,
  still,
}: {
  children: ReactNode;
  accent?: Accent;
  delay?: number;
  still?: boolean;
}) {
  return (
    <motion.div
      {...pop(delay, still)}
      className={`${MONO} mt-4 flex items-center gap-2 rounded-xl border px-3 py-2.5`}
      style={{
        borderColor: `color-mix(in srgb, ${accentVar(accent)} 35%, transparent)`,
        background: `color-mix(in srgb, ${accentVar(accent)} 8%, transparent)`,
        color: accentVar(accent),
      }}
    >
      {children}
    </motion.div>
  );
}

/** A bar-field stand-in for audio. Static heights — this is a diagram of a
 *  waveform, not a live meter, and a fake meter that never stops is exactly the
 *  ambient loop this page does not run. */
export function Wave({
  bars = 22,
  className = "",
  accent = "cyan",
  delay = 0,
  still,
}: {
  bars?: number;
  className?: string;
  accent?: Accent;
  delay?: number;
  still?: boolean;
}) {
  return (
    <div className={`flex items-end gap-[3px] ${className}`} aria-hidden>
      {Array.from({ length: bars }, (_, i) => {
        // Deterministic so the server and the client draw the same waveform.
        const h = 22 + 66 * Math.abs(Math.sin(i * 1.37));
        return (
          <motion.span
            key={i}
            initial={still ? { scaleY: 1, opacity: 1 } : { scaleY: 0.12, opacity: 0 }}
            animate={{ scaleY: 1, opacity: 1 }}
            transition={still ? undefined : { delay: delay + i * 0.012, duration: 0.32 }}
            className="w-[3px] origin-bottom rounded-full"
            style={{ height: `${h}%`, background: accentVar(accent), opacity: 0.75 }}
          />
        );
      })}
    </div>
  );
}
