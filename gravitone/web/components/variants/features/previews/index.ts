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

export type PreviewKey =
  | "compat"
  | "cast"
  | "sovereign"
  | "score"
  | "stream"
  | "performance"
  | "agents"
  | "arm";

export type PreviewDef = {
  icon: ComponentType<{ className?: string }>;
  /** Animated body. `still` is the visitor's reduced-motion preference, passed
   *  down rather than read here so every preview resolves it identically. */
  Body: ComponentType<{ still: boolean }>;
};

export const PREVIEWS: Record<PreviewKey, PreviewDef> = {
  compat: { icon: AudioLines, Body: CompatPreview },
  cast: { icon: Users, Body: CastPreview },
  sovereign: { icon: ShieldOff, Body: SovereignPreview },
  score: { icon: Highlighter, Body: ScorePreview },
  stream: { icon: Activity, Body: StreamPreview },
  performance: { icon: ScrollText, Body: PerformancePreview },
  agents: { icon: Radio, Body: AgentsPreview },
  arm: { icon: Cpu, Body: ArmPreview },
};

export const PREVIEW_KEYS = Object.keys(PREVIEWS) as PreviewKey[];

export function isPreviewKey(k: string): k is PreviewKey {
  return k in PREVIEWS;
}
