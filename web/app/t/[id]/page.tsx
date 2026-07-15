// Public share page for one take — a landing page per shared clip. The
// emotion ribbon + synced glyph player demonstrate the metatag
// differentiator to every visitor; the CTA leads into the playground.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Wordmark } from "@/components/ui/Primitives";
import { loadTake } from "@/lib/takes";
import TakeCard from "./TakeCard";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const take = await loadTake(id);
  if (!take) return { title: "Take not found — Gravitone" };
  const emotions = [...new Set(take.segments.map((s) => s.used))].join(", ");
  return {
    title: `${take.character_name} performs — Gravitone`,
    description: `"${take.text.slice(0, 140)}" · ${take.seconds}s, emotions: ${emotions}. Cloned + synthesized on a CPU.`,
    openGraph: {
      title: `${take.character_name} performs — Gravitone`,
      description: `${take.seconds}s of emotion-directed speech (${emotions}) — no GPU, no per-character bill.`,
      images: [`/emotions/${take.segments.find((s) => s.used !== "baseline")?.used ?? "baseline"}.png`],
    },
  };
}

export default async function TakePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const take = await loadTake(id);
  if (!take) notFound();

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

        <div className="pt-8">
          <TakeCard take={take} />
        </div>

        {/* try-it-yourself CTA — every share is a landing page */}
        <div className="glass-panel mt-6 rounded-2xl p-5 text-center">
          <p className="text-sm text-white/70">
            This voice switches emotions mid-sentence with inline{" "}
            <span className="font-jetbrains text-cyan-300">[emotion]</span> tags — cloned and
            synthesized on an ordinary CPU. No GPU, no per-character bill.
          </p>
          <Link href="/"
            className="cta-glow mt-4 inline-block rounded-full bg-gradient-to-r from-cyan-300 to-cyan-200 px-6 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110">
            Try it with your voice →
          </Link>
        </div>

        <footer className="mt-10 text-center">
          <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/40">
            runs on arm · self-hostable · mit
          </span>
        </footer>
      </div>
    </div>
  );
}
