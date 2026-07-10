import Image from "next/image";
import { emotionMeta } from "@/lib/emotions";

/**
 * Glowing per-emotion emblem. The source art is line-art on pure black, so
 * `mix-blend-screen` drops the black cleanly on the dark UI. `dim` fades
 * unavailable slots. Set `size` to the rendered px box.
 */
export default function EmotionArt({
  emotion,
  size = 96,
  dim = false,
  className = "",
}: {
  emotion: string;
  size?: number;
  dim?: boolean;
  className?: string;
}) {
  const m = emotionMeta(emotion);
  return (
    <Image
      src={m.art}
      alt={`${m.label} emotion`}
      width={size}
      height={size}
      draggable={false}
      className={`pointer-events-none select-none object-contain mix-blend-screen transition ${
        dim ? "opacity-25 grayscale" : "opacity-100"
      } ${className}`}
    />
  );
}
