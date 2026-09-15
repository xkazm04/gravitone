// Public client-review page — no login. The creator sends this link; the
// client hears each take and approves one.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Wordmark } from "@/components/ui/Primitives";
import ReviewPicker from "./ReviewPicker";
import { loadReview } from "./loadReview";

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
