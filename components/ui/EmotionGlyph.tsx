"use client";

// Animated, self-drawing emotion glyph (traced via /motionize). Renders the
// baked {d, fill, delay}[] as a staggered center-out reveal, with the neon glow
// restored by an SVG blur filter. Opacity always animates (safe under reduced
// motion); scale is the extra flourish.

import { useId } from "react";
import { motion } from "framer-motion";
import { GLYPHS } from "@/lib/glyphs";

const SPREAD = 0.5; // seconds across the whole reveal

export default function EmotionGlyph({
  emotion,
  size = 58,
  glow = true,
  animate = true,
  dim = false,
  className = "",
}: {
  emotion: string;
  size?: number;
  glow?: boolean;
  animate?: boolean;
  dim?: boolean;
  className?: string;
}) {
  const gid = useId().replace(/:/g, "");
  const glyph = GLYPHS[emotion] ?? GLYPHS.baseline;
  const maxDelay = glyph.paths.reduce((m, p) => Math.max(m, p.delay), 1) || 1;

  return (
    <svg
      viewBox={glyph.viewBox}
      width={size}
      height={size}
      className={`overflow-visible ${dim ? "opacity-30" : ""} ${className}`}
      aria-hidden
    >
      <defs>
        <filter id={`glow-${gid}`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="7" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g filter={glow && !dim ? `url(#glow-${gid})` : undefined}>
        {glyph.paths.map((p, i) => (
          <motion.path
            key={i}
            d={p.d}
            fill={p.fill}
            initial={animate ? { opacity: 0, scale: 0.6 } : false}
            animate={{ opacity: 1, scale: 1 }}
            transition={{
              duration: 0.5,
              delay: animate ? (p.delay / maxDelay) * SPREAD : 0,
              ease: [0.22, 1, 0.36, 1],
            }}
            style={{ transformOrigin: "center", transformBox: "fill-box" }}
          />
        ))}
      </g>
    </svg>
  );
}
