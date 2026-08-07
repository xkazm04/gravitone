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
 *
 * Every body is drawn in the SIGNAL vocabulary (previews/illus.tsx): an
 * oscilloscope picture of the mechanism, one accent per diagram, with the prose
 * demoted to a single caption underneath. That is the whole vocabulary — the
 * row-stack previews these replaced are gone, so a new spotlight has exactly one
 * house style to match.
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
import CompatSignal from "./CompatSignal";
import CastSignal from "./CastSignal";
import SovereignSignal from "./SovereignSignal";
import ScoreSignal from "./ScoreSignal";
import StreamSignal from "./StreamSignal";
import PerformanceSignal from "./PerformanceSignal";
import AgentsSignal from "./AgentsSignal";
import ArmSignal from "./ArmSignal";

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

export type PreviewDef = {
  icon: ComponentType<{ className?: string }>;
  /** The animated diagram. `still` is the visitor's reduced-motion preference,
   *  passed down rather than read here so every preview resolves it
   *  identically. */
  Body: PreviewBody;
};

export const PREVIEWS: Record<PreviewKey, PreviewDef> = {
  compat: { icon: AudioLines, Body: CompatSignal },
  cast: { icon: Users, Body: CastSignal },
  sovereign: { icon: ShieldOff, Body: SovereignSignal },
  score: { icon: Highlighter, Body: ScoreSignal },
  stream: { icon: Activity, Body: StreamSignal },
  performance: { icon: ScrollText, Body: PerformanceSignal },
  agents: { icon: Radio, Body: AgentsSignal },
  arm: { icon: Cpu, Body: ArmSignal },
};

export const PREVIEW_KEYS = Object.keys(PREVIEWS) as PreviewKey[];

export function isPreviewKey(k: string): k is PreviewKey {
  return k in PREVIEWS;
}
