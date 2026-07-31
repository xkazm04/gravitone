// Obsidian design system — the single quality bar every module variant mines.
// Import these instead of re-deriving colors/motion so modules read as siblings
// of the landing page, not one-off prototypes.
//
// SINGLE SOURCE OF TRUTH. The design language used to be declared three times
// (here, hand-copied into globals.css, and again inline in StudioDark) and the
// three had already drifted. Now every literal lives in THIS file, is emitted
// once as CSS custom properties by <GravitoneTokens> (layout.tsx), and both
// globals.css and the variants consume the vars. This file is the only place in
// web/ that may contain colour literals.

export const EASE = [0.22, 1, 0.36, 1] as const;
/** The same curve as EASE, in CSS form (`--gt-ease`). */
export const EASE_CSS = `cubic-bezier(${EASE[0]}, ${EASE[1]}, ${EASE[2]}, ${EASE[3]})`;

export const ACCENT = {
  cyan: "#67e8f9",
  violet: "#a78bfa",
  emerald: "#6ee7b7",
} as const;

/** Page ink — the studio background. */
export const INK = "#080a10";

/**
 * framer-motion entrance preset (entry-only — never infinite; see /prototype
 * "animation austerity"). Use custom={i} to stagger.
 *
 * `makeRise` exists because surfaces legitimately want different weights (the
 * landing hero rises further and slower than a dense module panel). The curve —
 * the part that must never drift — is always EASE.
 */
export function makeRise({ y = 20, duration = 0.6, stagger = 0.07 } = {}) {
  return {
    hidden: { opacity: 0, y },
    show: (i = 0) => ({
      opacity: 1,
      y: 0,
      transition: { duration, ease: EASE, delay: i * stagger },
    }),
  };
}
export const rise = makeRise();

// canonical surface + text classes
export const SURFACE =
  "border border-white/8 bg-gradient-to-b from-white/[0.05] to-white/[0.015] backdrop-blur-[14px]";
export const HAIRLINE = "border-white/8";
export const TEXT = {
  hero: "font-instrument text-white",
  body: "font-hanken text-slate-300",
  label: "font-jetbrains uppercase tracking-[0.18em] text-cyan-300",
  meta: "font-jetbrains text-white/45",
} as const;

/**
 * Design tokens as CSS custom properties. Emitted verbatim by
 * <GravitoneTokens>; consumed by globals.css and by any component that needs a
 * value at runtime. Every entry here replaces a literal that used to be
 * hand-copied into globals.css — the values are byte-identical to what shipped,
 * so publishing them changes zero pixels.
 */
export const CSS_TOKENS: Record<string, string> = {
  // accents
  "--gt-accent-cyan": ACCENT.cyan,
  "--gt-accent-violet": ACCENT.violet,
  "--gt-accent-emerald": ACCENT.emerald,
  "--gt-ink": INK,

  // glass surface (.glass-panel / SURFACE)
  "--gt-surface-top": "rgba(255,255,255,0.05)",
  "--gt-surface-bottom": "rgba(255,255,255,0.015)",
  "--gt-hairline": "rgba(255,255,255,0.08)",
  "--gt-blur": "14px",

  // aurora atmosphere (.aurora)
  "--gt-aurora-1": "rgba(34,211,238,0.18)",
  "--gt-aurora-2": "rgba(139,92,246,0.16)",
  "--gt-aurora-3": "rgba(16,185,129,0.10)",

  // cyan glow (.cta-glow, .switch-slider thumb)
  "--gt-ring-cyan": "rgba(103,232,249,0.3)",
  "--gt-glow-cyan": "rgba(103,232,249,0.45)",
  "--gt-glow-cyan-strong": "rgba(103,232,249,0.6)",
  "--gt-track-cyan": "rgba(103,232,249,0.55)",
  "--gt-track-violet": "rgba(167,139,250,0.55)",
  "--gt-thumb-ring": "rgba(8,10,16,0.9)",

  // motion
  "--gt-ease": EASE_CSS,
  "--gt-eq-period": "1.1s",
  "--gt-aurora-period": "22s",
};

/**
 * Signal Layer channel defaults (contract C4). Declared on :root so every
 * reader resolves even when no AudioBus is mounted or no source is registered —
 * at these values every reader is a no-op, which is what preserves the idle
 * look. AudioBus overrides them on its own scoped node.
 */
export const SIGNAL_DEFAULTS: Record<string, string> = {
  "--gt-level": "0",
  "--gt-peak": "0",
  "--gt-centroid": "0.5",
  "--gt-hue": "190",
  "--gt-working": "0",
};

/** The `:root { … }` rule <GravitoneTokens> injects. */
export function tokensCss(): string {
  const decls = [
    ...Object.entries(CSS_TOKENS),
    ...Object.entries(SIGNAL_DEFAULTS),
  ]
    .map(([k, v]) => `${k}:${v};`)
    .join("");
  return `:root{${decls}}`;
}
