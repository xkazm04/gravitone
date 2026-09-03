// Public client-review page — no login. The creator sends this link; the
// client hears each take and approves one.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Wordmark } from "@/components/ui/Primitives";
import { backendFetch, READ_TIMEOUT_MS } from "@/lib/backend";
import ReviewPicker, { type Review } from "./ReviewPicker";

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

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const loaded = await loadReview(id);
  // A backend that could not be read is NOT a review that does not exist. Client
  // work is never indexed either way, so the title is the whole message.
  if (loaded.status !== "ok") {
    return {
      title: loaded.status === "gone"
        ? "Review not found — Gravitone"
        : "Review temporarily unavailable — Gravitone",
      robots: { index: false },
    };
  }
  const review = loaded.review;
  return {
    title: `${review.title} — pick a take`,
    description: `${review.takes.length} voice takes of the same script. Listen and approve one — no account needed.`,
    robots: { index: false }, // client work is not for the index
  };
}

/** The page shell every state of this route wears — a client who followed a
 *  review link lands on something branded whichever answer we got. */
function ReviewShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-hanken relative min-h-screen overflow-hidden bg-[#080a10] text-slate-200 grain">
      <div className="pointer-events-none absolute inset-0 aurora" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />
      <div className="relative mx-auto max-w-2xl px-6">
        <nav className="flex items-center justify-between py-6">
          <Link href="/" aria-label="Gravitone home"><Wordmark /></Link>
        </nav>
        {children}
      </div>
    </div>
  );
}

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loaded = await loadReview(id);
  // A review the backend says is not there is a 404 — as is one with nothing to
  // listen to, which is a link that can never be acted on. A backend we could
  // not read is NEITHER.
  if (loaded.status === "gone") notFound();
  if (loaded.status === "unreachable") {
    return (
      <ReviewShell>
        <div className="pt-12">
          <h1 className="font-jetbrains text-[13px] uppercase tracking-widest text-white/50">
            review {id}
          </h1>
          <p className="mt-3 text-lg text-white/80">
            This review could not be loaded right now.
          </p>
          <ErrorBanner severity="error">
            {loaded.detail} — the review link is still valid; this studio could not reach the
            engine that stores it. Reload in a moment.
          </ErrorBanner>
          <p className="mt-4 pb-16 text-sm text-white/55">
            Nothing has been withdrawn: an unreadable backend is not a cancelled review, and this
            page will not claim otherwise. Whoever sent you this link does not need to send
            another one.
          </p>
        </div>
      </ReviewShell>
    );
  }
  if (loaded.review.takes.length === 0) notFound();

  return (
    <ReviewShell>
      <div className="pt-4">
        <ReviewPicker review={loaded.review} />
      </div>
    </ReviewShell>
  );
}
