"use client";

// Procedural sigil for a custom emotion — the auto-generated counterpart to
// the hand-traced art. Deterministic from the emotion name, tinted with its
// derived hue, and drawn with the same center-out stagger as the baked
// glyphs so custom slots feel first-class.

import { useMemo } from "react";
import { motion } from "framer-motion";
import { generateGlyph } from "@/lib/glyphs/generate";
import { emotionMeta } from "@/lib/emotions";

export default function GeneratedGlyph({
  emotion,
  size = 96,
  dim = false,
  animate = true,
  className = "",
}: {
  emotion: string;
  size?: number;
  dim?: boolean;
  animate?: boolean;
  className?: string;
}) {
  const glyph = useMemo(() => generateGlyph(emotion), [emotion]);
  const { hue, label } = emotionMeta(emotion);

  return (
    <svg
      viewBox={glyph.viewBox}
      width={size}
      height={size}
      role="img"
      aria-label={`${label} emotion`}
      className={`pointer-events-none select-none transition ${dim ? "opacity-25 grayscale" : "opacity-100"} ${className}`}
      style={{ color: `hsl(${hue} 85% 62%)`, filter: dim ? undefined : `drop-shadow(0 0 10px hsl(${hue} 90% 60% / .45))` }}
    >
      {glyph.paths.map((p, i) =>
        animate ? (
          <motion.path
            key={i}
            d={p.d}
            fill={p.fill}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: p.delay, ease: [0.22, 1, 0.36, 1] }}
            style={{ transformOrigin: "512px 512px" }}
          />
        ) : (
          <path key={i} d={p.d} fill={p.fill} />
        ),
      )}
    </svg>
  );
}
