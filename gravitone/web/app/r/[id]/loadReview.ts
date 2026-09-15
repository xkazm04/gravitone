// Reading a review — kept out of page.tsx so the route stays a valid Next.js
// Page (a page.tsx may only export the page's own default/config fields;
// exporting `loadReview` from it fails the Next 15 typed-Page check with
// `"loadReview" is not a valid Page export field`). Mirrors how the sibling
// route keeps its read out of page.tsx too (`@/lib/takes.server`), just local
// to this route instead of shared, since nothing else needs it.
import { backendFetch, READ_TIMEOUT_MS } from "@/lib/backend";
import type { Review } from "./ReviewPicker";

/**
 * The three answers a review link can honestly get — deliberately the SAME
 * vocabulary and shape as `lib/takes.ts::TakeLoad`, because these are the same
 * two failures on the sibling public surface one directory over.
 *
 * This route used to map EVERY failure — connection refused, 5xx, read timeout —
 * to one null, and `notFound()` it. So a client who opened a review link during
 * a backend restart was told the link was dead. It is not: the link is fine and
 * the box is not answering, and the person who sent that link is the one who
 * pays for the lie. `gone` is a permanent answer, `unreachable` a temporary one.
 */
export type ReviewLoad =
  | { status: "ok"; review: Review }
  | { status: "gone" }
  | { status: "unreachable"; detail: string };

/** Fetch one review server-side, saying WHICH failure happened.
 *
 *  gone         — the backend answered, and this review is not there (never
 *                 existed, or expired). A permanent 404.
 *  unreachable  — the backend never answered, or answered with a server error.
 *                 The review may be perfectly fine. */
export async function loadReview(id: string): Promise<ReviewLoad> {
  let r: Response;
  try {
    r = await backendFetch(`/v1/reviews/${encodeURIComponent(id)}`, {
      credential: "operator",
      cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    // No response at all: connection refused, DNS, or the read timeout fired.
    return { status: "unreachable", detail: "Gravitone backend unreachable" };
  }
  if (r.status === 404) return { status: "gone" };
  if (!r.ok) return { status: "unreachable", detail: await readReviewDetail(r) };
  try {
    return { status: "ok", review: (await r.json()) as Review };
  } catch {
    // A 200 whose body is not JSON is a broken backend, not a missing review.
    return { status: "unreachable", detail: "the backend answered with an unreadable review" };
  }
}

/** The backend's own sentence for a failed read, defensively parsed — the same
 *  contract lib/apiFetch applies on the client and lib/takes applies for a
 *  share link, applied here because this read happens on the server. */
async function readReviewDetail(r: Response): Promise<string> {
  try {
    const body = (await r.json()) as { detail?: unknown };
    if (typeof body?.detail === "string" && body.detail) return body.detail;
  } catch {
    /* not JSON — fall through to the status sentence */
  }
  return r.status === 503
    ? "Gravitone backend unreachable"
    : `the backend answered ${r.status} for this review`;
}
