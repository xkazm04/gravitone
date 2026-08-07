import Image from "next/image";
import { emotionMeta } from "@/lib/emotions";
import GeneratedGlyph from "./GeneratedGlyph";

/**
 * Glowing per-emotion emblem. Base emotions use hand-traced art (line-art on
 * pure black, so `mix-blend-screen` drops the black cleanly on the dark UI);
 * CUSTOM emotions have no baked image and fall back to their procedural
 * sigil, generated deterministically from the name. `dim` fades unavailable
 * slots. Set `size` to the rendered px box.
 *
 * THIS IS THE EMBLEM, NOT THE ICON. It is legible as a 52-72px hero — the take
 * page's playhead glyph and the guided recorder's header, its two remaining
 * callers — and it was unreadable everywhere else it used to be mounted: hue-
 * derived abstract art, filled with the mid-luminance span tint, shrunk to a
 * 12-20px badge on a near-black panel. Every identifying mark now renders
 * `EmotionIcon` (a stroke icon from lib/emotions::EMOTION_ICONS, in a hue
 * lifted to a foreground luminance). Do not reach for this component below
 * ~48px; reach for that one.
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

  if (!m.art) {
    return <GeneratedGlyph emotion={emotion} size={size} dim={dim} className={className} />;
  }

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
