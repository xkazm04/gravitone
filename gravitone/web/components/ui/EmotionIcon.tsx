// The emotion ICON — the small, identifying mark, as opposed to EmotionArt's
// emblem.
//
// The generated sigils were the same asset at every size, and at badge scale
// (12-20px) they failed twice over on this dark theme: the shapes are abstract
// hue-derived rays that carry no meaning until they are large, and they were
// filled with the RAW emotion hue — a mid-luminance colour chosen to be a
// pleasant span tint, which against `#0b0e15` lands well under a readable
// contrast. A tint that works as a 26%-opacity wash behind words is not a
// foreground.
//
// So this component makes two separate decisions:
//
//  * SHAPE comes from a prebuilt pack (lucide-react, mapped in
//    lib/emotions::EMOTION_ICONS) — hinted stroke art designed to be read at
//    16px, and semantic rather than decorative: excited is a bolt, whisper is a
//    low speaker, baseline is a flat line because baseline is the absence of
//    direction.
//  * COLOUR is the emotion hue LIFTED to a foreground luminance (85% light),
//    never the raw hue. The hue still identifies the emotion — the span
//    highlights and track lanes it has to agree with are unchanged — it is only
//    lightened to the point where a 2px stroke survives the background.
//
// Decorative by default (`aria-hidden`): every surface that shows an emotion
// icon also shows its label, or names it on the control the icon sits inside.
// Pass `label` on the rare surface where the icon IS the only identification.

import { emotionIcon, emotionMeta } from "@/lib/emotions";

/** Chip / badge / row scale. The floor a stroke icon stays readable at, and the
 *  reason nothing here is offered a smaller default. */
const DEFAULT_SIZE = 16;

export default function EmotionIcon({
  emotion,
  size = DEFAULT_SIZE,
  dim = false,
  label,
  className = "",
}: {
  emotion: string;
  /** Rendered px box. Keep it at 16 or above — that is the whole point. */
  size?: number;
  /** This Character has not recorded the emotion. Faded to a still-readable
   *  white rather than to the unreadable hue it used to fade to. */
  dim?: boolean;
  /** Give the icon an accessible name. Omit when a visible label or the parent
   *  control already carries it — which is the usual case. */
  label?: string;
  className?: string;
}) {
  const Icon = emotionIcon(emotion);
  const { hue } = emotionMeta(emotion);
  return (
    <Icon
      size={size}
      // Thicker than lucide's 2/24 default at small sizes: a hairline stroke is
      // the other way an icon disappears on a dark panel.
      strokeWidth={size <= 20 ? 2.25 : 2}
      absoluteStrokeWidth={false}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      data-emotion-icon={emotion}
      className={`shrink-0 ${className}`}
      style={{ color: dim ? "rgba(255,255,255,0.5)" : `hsl(${hue} 90% 85%)` }}
    />
  );
}
