// ── synthesis ────────────────────────────────────────────────────────────────

import { readDetail } from "@/lib/apiFetch";
import { bakedUrl, type BakeManifest } from "@/lib/narratable";

/** A failure the dock can NAME. `retryAfter` is set only for backpressure. */
export class NarrationError extends Error {
  constructor(message: string, readonly kind: "busy" | "unreachable" | "refused" | "blocked" | "failed") {
    super(message);
    this.name = "NarrationError";
  }
}

/**
 * Turn one non-OK /api/speak response into a sentence a visitor can act on.
 *
 * /api/speak is the studio's PUBLIC relay: the server attaches its own
 * GRAVITONE_API_KEY (lib/backend#backendFetch), so listening needs no account
 * and no key of the visitor's own. That is exactly why a 401/403 here has to be
 * reported as a DEPLOYMENT fact ("this deployment's relay key is missing or
 * rejected") rather than as something the listener did wrong or could fix by
 * signing in.
 */
async function speakFailure(res: Response): Promise<NarrationError> {
  const detail = await readDetail(res);
  if (res.status === 429) {
    const wait = Math.max(1, Math.ceil(Number(res.headers.get("Retry-After")) || 1));
    return new NarrationError(
      `the speech engine is busy — it will take this again in about ${wait}s`, "busy");
  }
  if (res.status === 401 || res.status === 403) {
    return new NarrationError(
      "the speech relay was refused — this deployment's server key is missing or rejected", "refused");
  }
  if (res.status === 503 && detail?.includes("unreachable")) {
    return new NarrationError("the speech engine is unreachable from here", "unreachable");
  }
  if (res.status === 503) {
    return new NarrationError("the speech engine is restarting — try again in a moment", "unreachable");
  }
  if (res.status === 404) {
    return new NarrationError(
      detail ?? "that narrator no longer exists on this deployment", "failed");
  }
  return new NarrationError(detail ?? `synthesis failed (${res.status})`, "failed");
}

/**
 * A clip that was rendered at BUILD time (web/scripts/bake-narration.ts).
 *
 * Preferred over synthesis whenever the key is in the manifest, because it is
 * the same audio: the bake computes `clipKey` from this very module, with the
 * same emotion tag and the same narrator, so a hit is not an approximation of
 * the live reading — it IS the live reading, rendered once.
 *
 * A miss returns null and the caller synthesizes. A manifest that promises a
 * clip the server does not serve is treated as a miss too, rather than as an
 * error: a stale manifest should cost a round trip, not the reading.
 */
export async function fetchBaked(
  manifest: BakeManifest | null, key: string, signal: AbortSignal,
): Promise<Blob | null> {
  const url = bakedUrl(manifest, key);
  if (!url) return null;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.size > 0 ? blob : null;
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "AbortError") throw e;
    return null;
  }
}

/** Synthesize one tagged sentence. Throws a NarrationError on every failure —
 *  there is no browser-voice fallback here on purpose: a robot voice reading
 *  the marketing copy of a voice company is worse than an honest apology. */
export async function synthesize(characterId: string, tagged: string, signal: AbortSignal): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ character_id: characterId, text: tagged }),
      signal,
    });
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "AbortError") throw e;
    throw new NarrationError("could not reach the speech relay from this browser", "unreachable");
  }
  if (!res.ok) throw await speakFailure(res);
  return res.blob();
}

/** Where the bytes now playing came from. Stated rather than hidden: "cached"
 *  and "baked" and "rendered just now" are three different claims about what
 *  this listen cost, and a voice company that blurs them is describing its own
 *  product inaccurately. */
export type ClipSource = "cache" | "baked" | "live";
