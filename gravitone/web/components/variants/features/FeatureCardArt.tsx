import type { ReactNode } from "react";
import type { PreviewKey } from "./previews";

/*
 * The eight feature cards' background decoration — two layers, both inert.
 *
 * The cards used to be numbered ("01"…"08") and otherwise identical: the eye had
 * nothing to navigate by but the heading text, and a grid of eight equal blocks
 * of prose is a grid nobody reads. What replaced the number is art traced from
 * the MECHANISM the card claims — `compat` is a request whose base URL swaps,
 * `cast` is one waveform fanning into three lanes, `agents` is a duplex socket
 * with an interrupt. So each card is a low-contrast thumbnail of its own
 * spotlight, and the grid gets eight silhouettes to scan.
 *
 * Layer one is an accent wash bleeding off the bottom-right corner — it resolves
 * at thumbnail size before any line does. Layer two is the drawing, at 12%,
 * lifting to 20% and scaling a touch on hover.
 *
 * DARK-GLASS RULES, not the sticker-sheet ones this idea came from. Strokes are
 * `currentColor` and the wash is a `--gt-accent-*` var, so this file declares no
 * colour of its own (components/ui/tokens.ts is the only file in web/ that may).
 * There are no white knock-out fills: on ink they would punch holes rather than
 * separate shapes, so overlaps are handled by keeping the line count low.
 * Strokes are round-capped and 4-6 units on a 120 box — heavy enough to survive
 * 12% opacity, light enough not to compete with the copy sitting on top.
 *
 * Purely decorative: aria-hidden, no pointer events, no motion of its own beyond
 * the group's hover.
 */

type Art = { accent: "cyan" | "violet" | "emerald"; art: ReactNode };

const CARD_ART: Record<PreviewKey, Art> = {
  // A request card whose address line is swapped: old host struck through,
  // new host underlined, headers riding along unchanged.
  compat: {
    accent: "cyan",
    art: (
      <>
        <rect x="8" y="20" width="104" height="80" rx="12" fill="none" stroke="currentColor" strokeWidth="5" />
        <path d="M20 44h58" stroke="currentColor" strokeWidth="5" strokeLinecap="round" opacity="0.55" />
        <path d="M16 44h66" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        <path d="M20 62h72" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
        <path d="M20 72h72" stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity="0.6" />
        <path d="M20 84h34M64 84h28" stroke="currentColor" strokeWidth="4" strokeLinecap="round" opacity="0.5" />
      </>
    ),
  },
  // One waveform on the left fanning into three speaker lanes on the right.
  cast: {
    accent: "violet",
    art: (
      <>
        <path
          d="M10 60v-16M20 60v-30M30 60v-22M40 60v-34"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          transform="translate(0,26)"
        />
        <path d="M48 60 74 32M48 60h26M48 60 74 88" stroke="currentColor" strokeWidth="4" strokeLinecap="round" opacity="0.6" />
        <circle cx="88" cy="32" r="13" fill="none" stroke="currentColor" strokeWidth="5" />
        <circle cx="88" cy="60" r="13" fill="none" stroke="currentColor" strokeWidth="5" />
        <circle cx="88" cy="88" r="13" fill="none" stroke="currentColor" strokeWidth="5" />
      </>
    ),
  },
  // A closed box with the signal kept inside it, and a cloud cut off above.
  sovereign: {
    accent: "emerald",
    art: (
      <>
        <path d="M34 26a14 14 0 0 1 27-4 12 12 0 0 1 19 12h4" stroke="currentColor" strokeWidth="4" fill="none" strokeLinecap="round" opacity="0.45" />
        <path d="M30 34 92 14" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
        <rect x="16" y="48" width="88" height="60" rx="12" fill="none" stroke="currentColor" strokeWidth="6" />
        <path
          d="M32 78v-10M44 78v-20M56 78v-14M68 78v-24M80 78v-12M92 78v-18"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          transform="translate(0,12)"
        />
      </>
    ),
  },
  // Three spans painted over a line of text — the score, seen from far away.
  score: {
    accent: "violet",
    art: (
      <>
        <rect x="10" y="30" width="42" height="16" rx="6" fill="currentColor" opacity="0.5" />
        <rect x="58" y="30" width="30" height="16" rx="6" fill="currentColor" opacity="0.3" />
        <rect x="10" y="58" width="26" height="16" rx="6" fill="currentColor" opacity="0.4" />
        <rect x="42" y="58" width="52" height="16" rx="6" fill="currentColor" opacity="0.22" />
        <path d="M10 92h84" stroke="currentColor" strokeWidth="5" strokeLinecap="round" opacity="0.5" />
        <path d="M10 104h48" stroke="currentColor" strokeWidth="5" strokeLinecap="round" opacity="0.3" />
      </>
    ),
  },
  // Chunks arriving along a timeline, the first one already a waveform.
  stream: {
    accent: "cyan",
    art: (
      <>
        <path d="M8 100h104" stroke="currentColor" strokeWidth="4" strokeLinecap="round" opacity="0.4" />
        <path d="M14 88v-14M22 88v-30M30 88v-22M38 88v-36M46 88v-18" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
        <rect x="56" y="52" width="24" height="36" rx="7" fill="none" stroke="currentColor" strokeWidth="5" opacity="0.7" />
        <rect x="88" y="62" width="24" height="26" rx="7" fill="none" stroke="currentColor" strokeWidth="5" opacity="0.4" />
        <path d="M14 34h34" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
        <path d="M56 34h56" stroke="currentColor" strokeWidth="6" strokeLinecap="round" opacity="0.35" />
      </>
    ),
  },
  // A script page: three lines, each with its own speaker mark.
  performance: {
    accent: "emerald",
    art: (
      <>
        <rect x="14" y="10" width="92" height="100" rx="12" fill="none" stroke="currentColor" strokeWidth="5" />
        <circle cx="32" cy="34" r="6" fill="currentColor" />
        <path d="M46 34h44" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
        <circle cx="32" cy="60" r="6" fill="currentColor" opacity="0.6" />
        <path d="M46 60h32" stroke="currentColor" strokeWidth="6" strokeLinecap="round" opacity="0.6" />
        <circle cx="32" cy="86" r="6" fill="currentColor" opacity="0.35" />
        <path d="M46 86h40" stroke="currentColor" strokeWidth="6" strokeLinecap="round" opacity="0.35" />
      </>
    ),
  },
  // Two endpoints, arrows both ways, and the bolt of an interrupt between them.
  agents: {
    accent: "cyan",
    art: (
      <>
        <circle cx="24" cy="60" r="14" fill="none" stroke="currentColor" strokeWidth="5" />
        <circle cx="96" cy="60" r="14" fill="none" stroke="currentColor" strokeWidth="5" />
        <path d="M42 44h36m-8-7 8 7-8 7" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M78 78H42m8 7-8-7 8-7" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
        <path d="M62 18 52 40h14L56 62" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
      </>
    ),
  },
  // Four replicas on one die, and the meter they add up to.
  arm: {
    accent: "cyan",
    art: (
      <>
        <rect x="22" y="22" width="76" height="76" rx="12" fill="none" stroke="currentColor" strokeWidth="6" />
        {[38, 68].map((y) =>
          [38, 68].map((x) => (
            <rect key={`${x}-${y}`} x={x - 8} y={y - 8} width="16" height="16" rx="4" fill="currentColor" opacity="0.55" />
          )),
        )}
        <path d="M40 14v-8M60 14v-8M80 14v-8M40 114v-8M60 114v-8M80 114v-8" stroke="currentColor" strokeWidth="5" strokeLinecap="round" opacity="0.5" />
        <path d="M6 40h-0.5M6 60h-0.5M6 80h-0.5" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
        <path d="M14 40H6M14 60H6M14 80H6M114 40h-8M114 60h-8M114 80h-8" stroke="currentColor" strokeWidth="5" strokeLinecap="round" opacity="0.5" />
      </>
    ),
  },
};

/** The watermark layer for one feature card. Render first inside the card. */
export default function FeatureCardArt({ preview }: { preview: PreviewKey }) {
  const { accent, art } = CARD_ART[preview];
  return (
    <>
      {/* Layer 1 — the corner wash. Bleeds off the card so the card has a
          direction, and reads before any line art does at thumbnail size. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-20 -right-20 h-56 w-56 rounded-full opacity-[0.13] transition-opacity duration-300 ease-out group-hover:opacity-[0.22]"
        style={{
          background: `radial-gradient(circle, var(--gt-accent-${accent}), transparent 68%)`,
        }}
      />
      {/* Layer 2 — the mechanism, drawn. */}
      <svg
        viewBox="0 0 120 120"
        aria-hidden
        focusable="false"
        className="pointer-events-none absolute -bottom-6 -right-5 h-36 w-36 text-white opacity-[0.12] transition-[opacity,transform] duration-300 ease-out group-hover:scale-105 group-hover:opacity-[0.2]"
      >
        {art}
      </svg>
    </>
  );
}
