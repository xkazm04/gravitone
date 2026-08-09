// The leaderboard's arithmetic: measured Gravitone boxes and ElevenLabs list
// tiers reduced to one comparable number, and the geometry that draws it.

import {
  BENCHMARKS,
  boxCapacityAudPerS,
  costPerAudioHour,
  elCostPerAudioHour,
} from "@/lib/benchmarks";
import { ELEVENLABS_TIERS, fmtUsd } from "@/lib/switchkit";

export type Row = {
  name: string;
  detail: string;
  usdPerAudioHour: number;
  isGravitone: boolean;
};

export function buildRows(): Row[] {
  const g: Row[] = BENCHMARKS.filter((b) => b.instance && b.usdPerHour != null).map((b) => ({
    name: `Gravitone · ${b.instance}`,
    detail: `${b.platform} ${b.cpu} · ${boxCapacityAudPerS(b)} aud/s · ${b.notes}`,
    usdPerAudioHour: costPerAudioHour(b)!,
    isGravitone: true,
  }));
  const el: Row[] = ELEVENLABS_TIERS.map((t) => ({ t, c: elCostPerAudioHour(t.name) }))
    .filter((x): x is { t: (typeof ELEVENLABS_TIERS)[number]; c: number } => x.c != null)
    .map(({ t, c }) => ({
      name: `ElevenLabs · ${t.name}`,
      detail: `${fmtUsd(t.usdPerMonth)}/mo for ${(t.charsPerMonth / 1000).toLocaleString("en-US")}k chars (list price)`,
      usdPerAudioHour: c,
      isGravitone: false,
    }));
  return [...g, ...el].sort((a, b) => a.usdPerAudioHour - b.usdPerAudioHour);
}

// Bars span ~3 orders of magnitude — lay them out on a log scale.
export function logWidth(usd: number, min: number, max: number): number {
  const lo = Math.log10(min), hi = Math.log10(max);
  return 6 + 94 * ((Math.log10(usd) - lo) / (hi - lo || 1));
}
