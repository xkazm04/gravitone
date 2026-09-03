// What a REFUSED request means to this flow — the two places the studio used to
// say nothing, or say something untrue.
//
// Both live here rather than inline in the page because both are copy decisions
// (which is what a test can pin), not rendering.

import { readDetail } from "@/lib/apiFetch";

/**
 * The service's own sentence about an audio asset it would not serve.
 *
 * An <audio> element cannot read a 404 body: all the browser reports is "this
 * source did not play", which is why <TakePlayer> can only say "unplayable".
 * The sentence exists — `ingest_api.py::_segment_refusal` writes four
 * distinguished ones, and `job_expired()` writes the one that means the whole
 * session is gone — and since the ingest asset proxy now passes the upstream
 * status and body through (lib/backend#streamIngestAsset), one cheap re-request
 * after a failure fetches it.
 *
 * Called ONLY after playback has already failed, so the happy path costs
 * nothing. A re-request that unexpectedly succeeds returns null: the audio is
 * there, whatever went wrong was transient, and inventing a reason for it would
 * be the same lie in the other direction.
 */
export async function assetRefusal(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (r.ok) return null;
    return (await readDetail(r)) ?? null;
  } catch {
    // Nothing was refused — we could not ask. The caller keeps its own "this
    // did not play" state; adding a sentence we do not have would be worse.
    return null;
  }
}

export type CancelOutcome =
  | { ok: true }
  | { ok: false; detail: string };

/**
 * Cancel a commit that is already running.
 *
 * The old shape was `try { await fetch(DELETE) } catch { /* ignore * / }` and
 * then an UNCONDITIONAL start-over: the user was told the session was gone
 * while the backend could still be cloning voices into their roster. A DELETE
 * that fails is exactly the case where the flow must not lie about it, because
 * the thing left running writes to a place the user can see.
 *
 * A 404 is success: the job is already gone (`errors.job_expired`), which is
 * the state the cancel was asking for.
 */
export async function cancelIngest(jobId: string): Promise<CancelOutcome> {
  let r: Response;
  try {
    r = await fetch(`/api/ingest/${jobId}`, { method: "DELETE" });
  } catch {
    return { ok: false, detail: CANCEL_UNREACHABLE };
  }
  if (r.ok || r.status === 404) return { ok: true };
  const detail = await readDetail(r);
  return { ok: false, detail: detail ?? CANCEL_REFUSED };
}

/** The state a failed DELETE actually leaves behind — named, per the repo's
 *  rollback-copy rule: the clone may finish, and if it does the voices appear
 *  on the character. "Cancelled" is the one thing this must not say. */
export const CANCEL_UNFINISHED =
  "the backend may still be finishing this clone — check the roster before you start over";
const CANCEL_UNREACHABLE = "couldn't reach the studio to cancel";
const CANCEL_REFUSED = "the studio refused to cancel this session";
