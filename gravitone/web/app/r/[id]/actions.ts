"use server";

// The reviewer's "close, but..." path.
//
// Picking is final by design ("a new round is a new link"), which used to mean
// the only way to ask for a change was email. Revising mints that new link
// server-side, seeded from the take the client already approved — the decision
// on this round is never reopened.
//
// A server action rather than a proxy route: the backend credential lives in
// the server process (lib/backend), and this is the one mutation the review
// page needs beyond the pick it already proxies.

import { backendFetch, WRITE_TIMEOUT_MS } from "@/lib/backend";

export type ReviseResult =
  | { ok: true; reviewId: string; round: number }
  | { ok: false; error: string };

export async function requestRevision(
  reviewId: string,
  input: { note: string; reviewer?: string; direction?: string },
): Promise<ReviseResult> {
  const note = input.note.trim();
  if (!note) return { ok: false, error: "say what should change" };

  let r: Response;
  try {
    r = await backendFetch(`/v1/reviews/${encodeURIComponent(reviewId)}/revise`, {
      credential: "operator",
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        note: note.slice(0, 500),
        reviewer: (input.reviewer ?? "").trim().slice(0, 80),
        direction: (input.direction ?? "").trim().slice(0, 200),
      }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "the studio could not be reached — nothing was sent" };
  }

  // The backend's own detail (request id included) is what says what to do
  // about a 409 or a 404; a generic sentence here would throw it away.
  const body = (await r.json().catch(() => null)) as
    | { review_id?: string; round?: number; detail?: string }
    | null;
  if (!r.ok || !body?.review_id) {
    return { ok: false, error: body?.detail ?? "the revision round could not be opened" };
  }
  return { ok: true, reviewId: body.review_id, round: Number(body.round ?? 2) };
}
