// Public client-review page — no login. The creator sends this link; the
// client hears each take and approves one.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Wordmark } from "@/components/ui/Primitives";
import { backendFetch } from "@/lib/backend";
import ReviewPicker, { type Review } from "./ReviewPicker";

async function loadReview(id: string): Promise<Review | null> {
  try {
    const r = await backendFetch(`/v1/reviews/${encodeURIComponent(id)}`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as Review) : null;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const review = await loadReview(id);
  if (!review) return { title: "Review not found — Gravitone" };
  return {
    title: `${review.title} — pick a take`,
    description: `${review.takes.length} voice takes of the same script. Listen and approve one — no account needed.`,
    robots: { index: false }, // client work is not for the index
  };
}

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const review = await loadReview(id);
  if (!review || review.takes.length === 0) notFound();

  return (
    <div className="font-hanken relative min-h-screen overflow-hidden bg-[#080a10] text-slate-200 grain">
      <div className="pointer-events-none absolute inset-0 aurora" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />
      <div className="relative mx-auto max-w-2xl px-6">
        <nav className="flex items-center justify-between py-6">
          <Link href="/" aria-label="Gravitone home"><Wordmark /></Link>
        </nav>
        <div className="pt-4">
          <ReviewPicker review={review} />
        </div>
      </div>
    </div>
  );
}
