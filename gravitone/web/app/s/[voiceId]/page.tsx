// Public sign-off page — the speaker's door into the product. Mirrors the
// /t/{id} and /r/{id} shells: same aurora frame, same wordmark nav, no app
// chrome. Everything below the shell is client-side (Firebase auth + the vault
// row), because the record is written as the SPEAKER, not by the server.
import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/ui/Primitives";
import SignoffFlow from "./SignoffFlow";

// A consent link is a secret handed to one person — it must never be indexed,
// and the title must not leak whose voice it is (the id is all we have here
// anyway; the record itself is only read client-side, after sign-in).
export const metadata: Metadata = {
  title: "Sign off a voice clone — Gravitone",
  description: "Someone cloned a voice and is asking the speaker to sign off, on their own terms.",
  robots: { index: false, follow: false },
};

export default async function SignoffPage({
  params, searchParams,
}: {
  params: Promise<{ voiceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { voiceId } = await params;
  const q = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

  return (
    <div className="font-hanken relative min-h-screen overflow-hidden bg-[#080a10] text-slate-200 grain">
      <div className="pointer-events-none absolute inset-0 aurora" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />
      <div className="relative mx-auto max-w-2xl px-6 pb-20">
        <nav className="flex items-center justify-between py-6">
          <Link href="/" aria-label="Gravitone home"><Wordmark /></Link>
          <Link href="/" className="font-jetbrains rounded-full border border-white/15 px-4 py-1.5 text-[12px] text-white/85 transition hover:bg-white/5">
            what is this? →
          </Link>
        </nav>
        <div className="pt-6">
          <SignoffFlow voiceId={voiceId} ownerUid={one(q.o)} token={one(q.k)} />
        </div>
      </div>
    </div>
  );
}
