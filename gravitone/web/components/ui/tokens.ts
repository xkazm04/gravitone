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
 * Chart series colours — the landing pricing comparison, and any chart after it.
 *
 * NOT the ACCENT trio. The accents are display colours, tuned to glow on ink at
 * 24px type; as 2px data strokes they are far too light (OKLCH L 0.71–0.87)
 * and cyan sits close enough to emerald that the two are hard to tell apart at
 * hairline weight even with full colour vision. These steps were chosen by
 * running the dataviz palette validator against this page's own surface
 * (#080a10, dark mode) until every check passed:
 *
 *   categorical (identity): `el` vs `box`     — lightness band, chroma floor,
 *     CVD separation (worst adjacent ΔE 10.8 deutan), normal-vision floor
 *     (ΔE 20.8), contrast ≥ 3:1 — all PASS.
 *   ordinal (magnitude): `box` → `boxLarge`   — one hue (1° spread), monotone
 *     lightness, ΔL ≥ 0.06, light end 6.5:1 vs surface — all PASS.
 *
 * The two Arm boxes share a hue *because they are the same kind of thing*; the
 * bigger, costlier box is the darker step. ElevenLabs gets its own hue because
 * it is a different identity — deliberately violet and not a status colour:
 * amber/rose mean warning/error everywhere else in this app (ErrorBanner), and
 * a competitor's price line is not a fault condition.
 *
 * If you restyle a chart, re-run the validator rather than eyeballing it:
 *   node scripts/validate_palette.js "<hex,hex>" --mode dark --surface "#080a10"
 */
export const CHART = {
  /** ElevenLabs list price — the other bill. */
  el: "#9a6cf9",
  /** An Arm box, 24/7 — the small preset (t4g). */
  box: "#09a1c1",
  /** An Arm box, 24/7 — the larger preset (c7g); darker = costs more. */
  boxLarge: "#0b6d84",
  /** Recessive chrome: hairline grid, axis text. Never a data colour. */
  grid: "rgba(255,255,255,0.06)",
  axisText: "rgba(255,255,255,0.45)",
  /** STATUS, not a series. The amber the rest of the app already means
   *  "warning" with (ErrorBanner severity="warning", Tailwind amber-400/-200) —
   *  spelled here only because SVG attributes cannot take a Tailwind class.
   *  It marks the region where our own product is the worse buy. */
  warn: "#fbbf24",
  warnText: "#fde68a",
} as const;

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

  // chart series (see CHART above — validated, not eyeballed). Published as
  // vars so the legend swatches in the pricing section and the recharts strokes
  // in its lazy chart module cannot drift apart.
  "--gt-chart-el": CHART.el,
  "--gt-chart-box": CHART.box,
  "--gt-chart-box-large": CHART.boxLarge,

  // glass surface (.glass-panel / SURFACE)
  "--gt-surface-top": "rgba(255,255,255,0.05)",
  "--gt-surface-bottom": "rgba(255,255,255,0.015)",
  "--gt-hairline": "rgba(255,255,255,0.08)",
  "--gt-blur": "14px",

  // aurora atmosphere (.aurora)
  "--gt-aurora-1": "rgba(34,211,238,0.18)",
  "--gt-aurora-2": "rgba(139,92,246,0.16)",
  "--gt-aurora-3": "rgba(16,185,129,0.10)",

  // cyan glow (.cta-glow)
  "--gt-ring-cyan": "rgba(103,232,249,0.3)",
  "--gt-glow-cyan": "rgba(103,232,249,0.45)",
  // (--gt-glow-cyan-strong / --gt-track-* / --gt-thumb-ring went with the
  // landing bill-calculator slider they were the only consumer of. A token
  // nothing reads is drift waiting to happen.)

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
