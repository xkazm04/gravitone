// ── synthesis ────────────────────────────────────────────────────────────────

import { readDetail } from "@/lib/apiFetch";
import { bakedUrl, type BakeManifest } from "@/lib/narratable";

// ── the operator's trace ─────────────────────────────────────────────────────
//
// Two failures in this module are, correctly, invisible to the visitor: a baked
// clip the manifest promised but the server will not serve, and a lookahead
// prefetch that was refused. Neither costs the reading — the dock falls through
// to live synthesis and the sentence still plays. But "the bake is misconfigured
// on this deployment" and "this deployment never ran a bake" look IDENTICAL from
// the outside, and the first one silently spends a synth slot per sentence per
// visitor forever. So they are recorded: a bounded in-memory ring, a single
// console warning per distinct cause (a broken base path would otherwise emit
// forty), and a handle on `window` an operator can read on a live page.
//
// Nothing here is a UI surface. What the VISITOR is told is decided by
// narrationDockStatus, from the fact that a promised clip did not arrive — never
// from this log.

export type NarrationTraceKind = "bake-miss" | "prefetch-failed";

export type NarrationTraceEntry = {
  at: number;
  kind: NarrationTraceKind;
  detail: string;
  key?: string;
  url?: string;
  status?: number;
};

const TRACE_CAP = 24;
const TRACE: NarrationTraceEntry[] = [];
const WARNED = new Set<string>();

/** Everything the dock has quietly worked around this session, oldest first. */
export function narrationTrace(): NarrationTraceEntry[] {
  return TRACE.slice();
}

/** Test seam — and the handle an operator uses to clear the console noise. */
export function resetNarrationTrace(): void {
  TRACE.length = 0;
  WARNED.clear();
}

export function recordNarrationTrace(entry: Omit<NarrationTraceEntry, "at">): void {
  TRACE.push({ ...entry, at: Date.now() });
  if (TRACE.length > TRACE_CAP) TRACE.shift();
  // One warning per distinct cause. A wrong base path or a bad CDN rule makes
  // EVERY clip miss; forty identical lines would bury the one that matters.
  const cause = `${entry.kind}:${entry.status ?? ""}:${entry.key ?? entry.detail}`;
  if (!WARNED.has(cause)) {
    WARNED.add(cause);
    try {
      console.warn(`[gravitone/narration] ${entry.kind}: ${entry.detail}`);
    } catch {
      /* a console that refuses to log is not worth a second failure */
    }
  }
  try {
    (globalThis as { __gravitoneNarration?: unknown }).__gravitoneNarration = {
      trace: narrationTrace,
      reset: resetNarrationTrace,
    };
  } catch {
    /* frozen global — the ring is still readable from a module import */
  }
}

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
 *
 * But that second miss is not the same event as the first, and it is the one
 * that is somebody's fault. A key that is NOT in the manifest was never baked —
 * ordinary, silent, free. A key that IS in the manifest and will not fetch means
 * this deployment's static audio is unreachable (base path, CDN rule, half-
 * finished upload), which costs a live render per sentence per visitor for as
 * long as nobody notices. It is traced, and `onPromisedMiss` lets the caller
 * stop repeating the "baked, so it costs no engine" claim.
 */
export async function fetchBaked(
  manifest: BakeManifest | null,
  key: string,
  signal: AbortSignal,
  onPromisedMiss?: () => void,
): Promise<Blob | null> {
  const url = bakedUrl(manifest, key);
  if (!url) return null; // never baked — the ordinary case, and it costs nothing
  const missed = (detail: string, status?: number) => {
    recordNarrationTrace({ kind: "bake-miss", key, url, status, detail });
    onPromisedMiss?.();
  };
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      missed(`the manifest promises ${url} but this deployment answered ${res.status}`, res.status);
      return null;
    }
    const blob = await res.blob();
    if (blob.size > 0) return blob;
    missed(`the manifest promises ${url} but this deployment served zero bytes`);
    return null;
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "AbortError") throw e;
    missed(`the manifest promises ${url} but the request failed: ${(e as Error).message}`);
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
