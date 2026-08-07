/*
 * The feature-spotlight registry.
 *
 * Eight animated diagrams, one module each, keyed to the card that opens them.
 * The key is FEATURES[].key from lib/content.ts — the copy and the drawing have
 * to be the same claim, so they are addressed by the same name and a missing
 * pair is a type error rather than a blank modal.
 *
 * This registry pairs a key with its icon and its body. Title and copy come from
 * lib/content.ts, where the claims contract lives; nothing here restates them.
 */
import type { ComponentType } from "react";
import {
  Activity,
  AudioLines,
  Cpu,
  Highlighter,
  Radio,
  ScrollText,
  ShieldOff,
  Users,
} from "lucide-react";
import CompatPreview from "./CompatPreview";
import CastPreview from "./CastPreview";
import SovereignPreview from "./SovereignPreview";
import ScorePreview from "./ScorePreview";
import StreamPreview from "./StreamPreview";
import PerformancePreview from "./PerformancePreview";
import AgentsPreview from "./AgentsPreview";
import ArmPreview from "./ArmPreview";
import CompatSignal from "./CompatSignal";
import CompatStage from "./CompatStage";
import CastSignal from "./CastSignal";
import CastStage from "./CastStage";
import SovereignSignal from "./SovereignSignal";
import SovereignStage from "./SovereignStage";
import ScoreSignal from "./ScoreSignal";
import ScoreStage from "./ScoreStage";

export type PreviewKey =
  | "compat"
  | "cast"
  | "sovereign"
  | "score"
  | "stream"
  | "performance"
  | "agents"
  | "arm";

export type PreviewBody = ComponentType<{ still: boolean }>;

/** PROTOTYPING SCAFFOLD (throwaway). Three directional lenses on the same
 *  mechanism: `steps` is what shipped (list-rows + copy), `signal` tells it in
 *  waves and paths, `stage` as a spatial scene. Only `steps` is required — a
 *  feature whose new variants are not built yet falls back to it, so partial
 *  coverage renders instead of blanking. Deleted at consolidation, along with
 *  the tab strip in FeatureSpotlight. */
export const VARIANTS = ["steps", "signal", "stage"] as const;
export type PreviewVariant = (typeof VARIANTS)[number];

export type PreviewDef = {
  icon: ComponentType<{ className?: string }>;
  /** Animated bodies by lens. `still` is the visitor's reduced-motion
   *  preference, passed down rather than read here so every preview resolves it
   *  identically. */
  bodies: { steps: PreviewBody; signal?: PreviewBody; stage?: PreviewBody };
};

export const PREVIEWS: Record<PreviewKey, PreviewDef> = {
  compat: {
    icon: AudioLines,
    bodies: { steps: CompatPreview, signal: CompatSignal, stage: CompatStage },
  },
  cast: { icon: Users, bodies: { steps: CastPreview, signal: CastSignal, stage: CastStage } },
  sovereign: {
    icon: ShieldOff,
    bodies: { steps: SovereignPreview, signal: SovereignSignal, stage: SovereignStage },
  },
  score: {
    icon: Highlighter,
    bodies: { steps: ScorePreview, signal: ScoreSignal, stage: ScoreStage },
  },
  stream: { icon: Activity, bodies: { steps: StreamPreview } },
  performance: { icon: ScrollText, bodies: { steps: PerformancePreview } },
  agents: { icon: Radio, bodies: { steps: AgentsPreview } },
  arm: { icon: Cpu, bodies: { steps: ArmPreview } },
};

/** The body to render, with the steps fallback applied. */
export function previewBody(key: PreviewKey, variant: PreviewVariant): PreviewBody {
  const b = PREVIEWS[key].bodies;
  return b[variant] ?? b.steps;
}

export const PREVIEW_KEYS = Object.keys(PREVIEWS) as PreviewKey[];

export function isPreviewKey(k: string): k is PreviewKey {
  return k in PREVIEWS;
}
