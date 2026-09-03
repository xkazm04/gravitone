"use client";

// One spoke on the wheel: the emotion's mark, its availability, and — when
// there is room for it — the deep link that records the missing one.

import Link from "next/link";
import { motion } from "framer-motion";
import EmotionIcon from "@/components/ui/EmotionIcon";
import { EMOTION_IDS, emotionMeta } from "@/lib/emotions";
import { EASE } from "@/components/ui/tokens";

export default function EmotionSpoke({
  id, index, count, radius, compact, has, characterId, characterName,
  onPick, onClose, setActive, spokeRef,
}: {
  id: string;
  /** Position in ring order — its angle, its entrance delay, and the slot it
   *  registers itself in so the arrow keys can find it. */
  index: number;
  count: number;
  radius: number;
  compact: boolean;
  /** The Character has this emotion recorded. */
  has: boolean;
  characterId: string;
  characterName: string;
  onPick: (emotion: string) => void;
  onClose: () => void;
  setActive: React.Dispatch<React.SetStateAction<number | null>>;
  spokeRef: (el: HTMLButtonElement | null) => void;
}) {
  const e = emotionMeta(id);
  const i = index;
  const a = (i / count) * Math.PI * 2 - Math.PI / 2;
  // Rounded because `Math.cos(-PI/2)` is 6e-17, not 0, and an
  // unrounded product renders as `7.4e-15px` — legal CSS that
  // nothing downstream should have to parse.
  const x = Math.round(Math.cos(a) * radius);
  const y = Math.round(Math.sin(a) * radius);
  const custom = !EMOTION_IDS.includes(id);
  const disc = compact ? 44 : 64; // 44px is the touch-target floor
  // Positioning transform lives on a plain wrapper; the animated
  // button only touches opacity/scale (so framer's transform can't
  // clobber the translate — that was the "all nodes stacked" bug).
  return (
    <div className="absolute" style={{ transform: `translate(${x}px, ${y}px)` }}>
      <motion.button
        ref={spokeRef}
        initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.35, ease: EASE, delay: i * 0.04 }}
        onClick={() => { onPick(e.id); onClose(); }}
        onFocus={() => setActive(i)}
        onBlur={() => setActive((v) => (v === i ? null : v))}
        onMouseEnter={() => setActive(i)}
        onMouseLeave={() => setActive((v) => (v === i ? null : v))}
        // The accessible NAME carries availability and its
        // consequence. It used to carry neither: the art's alt
        // text plus the label, with the whole substitution story
        // in a `title` no touch or screen-reader user ever meets.
        aria-label={has
          ? `${e.label} — available`
          : `${e.label} — not recorded; the nearest recorded emotion is used, then baseline`}
        title={has ? `${e.label} — available` : `${e.label} — not recorded: the nearest recorded emotion is used, then baseline`}
        className="group flex cursor-pointer flex-col items-center"
        style={{ width: compact ? 64 : 96 }}
      >
        <span
          className="relative grid place-items-center overflow-hidden rounded-full border bg-black/60 transition-transform duration-300 group-hover:scale-110"
          style={{
            height: disc,
            width: disc,
            borderColor: has ? `hsl(${e.hue} 85% 60%)` : "rgba(255,255,255,0.15)",
            borderStyle: custom ? "dashed" : "solid", // custom slots read as bespoke
          }}
        >
          {/* hue glow — fades in on hover, out on leave */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            style={{ boxShadow: `0 0 26px hsl(${e.hue} 90% 60% / .65), inset 0 0 14px hsl(${e.hue} 90% 60% / .35)` }}
          />
          {/* The identifying mark. A stroke icon at half the
              disc, in the hue LIFTED to a foreground luminance —
              the sigil that used to sit here was hue-filled art
              that read as a smudge at this size. No brightness
              filter: the point of the lift is that the rest state
              is already readable. */}
          <EmotionIcon emotion={e.id} size={compact ? 22 : 30} dim={!has} />
          {/* A GLYPH, not a tint: availability that survives both
              a colourblind reader and a monochrome screenshot,
              and the only availability mark that fits a compact
              spoke at all. */}
          <span
            aria-hidden
            className={`font-jetbrains absolute right-0 bottom-0 grid h-4 w-4 place-items-center rounded-full border text-[9px] leading-none ${has ? "border-emerald-400/50 bg-emerald-500/25 text-emerald-100" : "border-amber-400/50 bg-amber-500/25 text-amber-100"}`}
          >
            {has ? "✓" : "+"}
          </span>
        </span>
        <span className="font-jetbrains mt-1.5 text-[11px] font-medium text-white transition group-hover:text-cyan-200 sm:text-[12px]">{e.label}</span>
      </motion.button>
      {/* status line lives OUTSIDE the button so a missing
          emotion can deep-link into the guided recorder. It is the
          first thing dropped when the wheel is compact — the hub
          says the same thing, with room for the sentence. */}
      {!compact && (has ? (
        <span className="font-jetbrains block w-24 text-center text-[11px]" style={{ color: "hsl(160 60% 60%)" }}>
          available
        </span>
      ) : (
        <Link
          href={`/voices/${encodeURIComponent(characterId)}?record=${e.id}`}
          onClick={onClose}
          title={`${characterName} has no ${e.label} voice yet — record it now`}
          className="font-jetbrains block w-24 text-center text-[11px] text-amber-300/80 underline-offset-2 transition hover:text-amber-200 hover:underline"
        >
          record →
        </Link>
      ))}
    </div>
  );
}
