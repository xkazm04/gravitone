// Obsidian design system — the single quality bar every module variant mines.
// Import these instead of re-deriving colors/motion so modules read as siblings
// of the landing page, not one-off prototypes.

export const EASE = [0.22, 1, 0.36, 1] as const;

export const ACCENT = {
  cyan: "#67e8f9",
  violet: "#a78bfa",
  emerald: "#6ee7b7",
} as const;

// framer-motion entrance preset (entry-only — never infinite; see /prototype
// "animation austerity"). Use custom={i} to stagger.
export const rise = {
  hidden: { opacity: 0, y: 20 },
  show: (i = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: EASE, delay: i * 0.07 },
  }),
};

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
