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

// Upstream response headers surface to the browser through ONE shared list
// (lib/serviceHeaders, mirroring the service's CORS_EXPOSE_HEADERS), not a
// literal kept here by hand: the local copy silently omitted X-Synth-Segments,
// which /v1/speak has always emitted for a multi-segment script.
export async function POST(req: NextRequest) {
  return proxyWavPost(req, "/v1/speak");
}
