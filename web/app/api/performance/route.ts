// Multi-character performance: a directed script of {character_id, text} lines
// synthesized in one call, Voices switching per character AND per emotion. The
// backend concatenates every line into one WAV and returns the full per-line /
// per-segment substitution report base64-JSON in X-Performance-Report.
//
// Shares its proxy mechanics with /api/speak via lib/backend#proxyWavPost (the
// backend URL + key stay server-side, timing/report headers are forwarded, and
// 429 backpressure is preserved, never flattened away).
import { NextRequest } from "next/server";

import { proxyWavPost } from "@/lib/backend";

const FORWARD_HEADERS = [
  "X-Audio-Seconds",
  "X-Realtime-Factor",
  "X-Synth-Seconds",
  "X-Queue-Seconds",
  "X-Ignored-Settings",
  "X-Performance-Report",
] as const;

export async function POST(req: NextRequest) {
  return proxyWavPost(req, "/v1/performance", FORWARD_HEADERS);
}
