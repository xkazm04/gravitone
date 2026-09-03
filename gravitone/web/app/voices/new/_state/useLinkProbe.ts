import { useEffect, useRef, useState } from "react";
import { readDetail } from "@/lib/apiFetch";

/**
 * The paste-time verdict for a pasted link.
 *
 * WHY IT EXISTS: the studio's own pre-check (uploadLimits.ts) decodes a File to
 * catch a too-long recording before it costs the user an upload. A URL has no
 * bytes to decode, so that check simply does not run for the link door — and
 * the caps behind it were sized for a clip somebody chose to upload. Without
 * this, pasting a two-hour podcast is answered only AFTER the download.
 *
 * So the backend is asked from METADATA alone (POST /api/ingest/link-probe, no
 * media transferred) and answers one of three things, each of which this hook
 * simply carries to the screen:
 *
 *   - fits            → `verdict.ok`, `trimmed: false`
 *   - too long        → `verdict.ok`, `trimmed: true` + the sentence naming the
 *                       cut ("47 minutes video — we'll clone the first 15
 *                       minutes"). The cut is never silent.
 *   - unusable        → `verdict.ok === false` with the reason, or `error` for
 *                       a link that could not be READ at all (private video,
 *                       not YouTube, no extractor on the box). Both name the
 *                       file-drop fallback, and neither is a spinner.
 *
 * The verdict is advisory: `scan-url` re-takes it server-side, so a stale or
 * skipped probe cannot get over-cap audio into the pipeline. That is why a
 * failed probe leaves the flow usable rather than wedged.
 */
export type LinkVerdict = {
  ok: boolean;
  title: string;
  duration: number | null;
  clip_seconds: number | null;
  trimmed: boolean;
  message: string;
  /** The exact attestation the commit will require for this job. */
  attestation?: string;
};

export type ProbeState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; verdict: LinkVerdict }
  /** The link could not be read. `detail` is the backend's own sentence. */
  | { status: "failed"; detail: string };

/** Long enough that typing a URL is one probe, short enough to feel immediate. */
export const PROBE_DEBOUNCE_MS = 600;

/** Cheap client-side shape test. Not a security control (the server owns the
 *  allowlist) — it only decides whether a keystroke is worth a round-trip. */
export function looksLikeUrl(raw: string): boolean {
  const s = raw.trim();
  return /^https?:\/\/[^\s]+\.[^\s]+/i.test(s);
}

export function useLinkProbe(url: string, enabled: boolean): ProbeState {
  const [state, setState] = useState<ProbeState>({ status: "idle" });
  // Which request is current. An answer from a URL the user has since edited
  // must never overwrite the verdict for the one now in the box.
  const latest = useRef(0);

  useEffect(() => {
    const trimmed = url.trim();
    if (!enabled || !looksLikeUrl(trimmed)) {
      latest.current += 1;   // cancel anything in flight
      setState({ status: "idle" });
      return;
    }
    const id = ++latest.current;
    let alive = true;
    const timer = setTimeout(async () => {
      setState({ status: "checking" });
      try {
        const r = await fetch("/api/ingest/link-probe", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed }),
        });
        if (!alive || id !== latest.current) return;
        if (!r.ok) {
          setState({ status: "failed",
            detail: (await readDetail(r)) ?? "couldn't read that link" });
          return;
        }
        const verdict = (await r.json()) as LinkVerdict;
        if (!alive || id !== latest.current) return;
        setState({ status: "done", verdict });
      } catch {
        if (!alive || id !== latest.current) return;
        // A transport failure is not a bad link, and saying "that video is
        // unavailable" here would be a lie. Say what is actually known.
        setState({ status: "failed",
          detail: "couldn't reach the Gravitone backend to check that link" });
      }
    }, PROBE_DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [url, enabled]);

  return state;
}
