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

// Forwarded headers come from the one shared list (lib/serviceHeaders) — see
// /api/speak for why a per-route literal was the bug.
// `output_format` rides through to the service — a 64-line performance is the
// largest thing this product makes, and it is the one most worth sending as mp3.
export async function POST(req: NextRequest) {
  return proxyWavPost(req, "/v1/performance", { credential: "operator", forwardQuery: ["output_format"] });
}
