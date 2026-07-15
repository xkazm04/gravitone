// Metatag-aware speech: one Character, Voices switched per emotion, baseline
// fallback. Forwards the per-segment report AND the honest timing / ignored-
// settings headers so the UI can show what actually ran, and preserves the
// upstream status (429 backpressure, Retry-After) instead of flattening every
// failure into one browser-voice fallback.
//
// The proxy mechanics live in lib/backend#proxyWavPost — shared with
// /api/performance, which was a byte-for-byte copy of this file.
import { NextRequest } from "next/server";

import { proxyWavPost } from "@/lib/backend";

// Upstream response headers we surface to the browser. Timing (synth/queue),
// realtime factor, the base64 per-segment report, and any accepted-but-inert
// voice settings — each only forwarded when the backend actually sent it.
const FORWARD_HEADERS = [
  "X-Audio-Seconds",
  "X-Realtime-Factor",
  "X-Synth-Seconds",
  "X-Queue-Seconds",
  "X-Ignored-Settings",
  "X-Segments",
] as const;

export async function POST(req: NextRequest) {
  return proxyWavPost(req, "/v1/speak", FORWARD_HEADERS);
}
