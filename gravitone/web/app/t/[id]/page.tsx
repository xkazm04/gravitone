// Public share page for one take — a landing page per shared clip. The
// emotion ribbon + synced glyph player demonstrate the metatag
// differentiator to every visitor; the CTA leads into the playground.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Wordmark } from "@/components/ui/Primitives";
import { loadLineage, loadTake } from "@/lib/takes";
import Lineage from "./Lineage";
import RePerform, { ReperformProvenance } from "./RePerform";
import TakeScore from "./TakeScore";
import OpenInRack from "./OpenInRack";
import TakeCard from "./TakeCard";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const loaded = await loadTake(id);
  // A backend that could not be read is NOT a take that does not exist — say
  // "unavailable" so a crawler (and a person reading a tab title) is not told
  // this share is dead when it is merely unreachable right now.
  if (loaded.status !== "ok") {
    return {
      title: loaded.status === "gone"
        ? "Take not found — Gravitone"
        : "Take temporarily unavailable — Gravitone",
      robots: { index: false },
    };
  }
  const take = loaded.take;
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

/** The page shell every state of this route wears — the take, and the state
 *  where there is no take to show. A visitor who followed a share link lands
 *  somewhere branded either way. */
function TakeShell({ children }: { children: React.ReactNode }) {
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
        {children}
      </div>
    </div>
  );
}

export default async function TakePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Two independent reads. The lineage is provenance — it must never be able to
  // cost the page its take, so it is awaited beside the take and degrades to
  // null (no lineage shown) on its own.
  const [loaded, lineage] = await Promise.all([loadTake(id), loadLineage(id)]);
  // A take the backend says is not there is a 404. A backend we could not read
  // is NOT — telling a visitor their link is dead during a restart is a lie
  // they cannot check, and one they would act on by throwing the link away.
  if (loaded.status === "gone") notFound();
  if (loaded.status === "unreachable") {
    return (
      <TakeShell>
        <div className="pt-12">
          <h1 className="font-jetbrains text-[13px] uppercase tracking-widest text-white/50">
            take {id}
          </h1>
          <p className="mt-3 text-lg text-white/80">
            This take could not be loaded right now.
          </p>
          <ErrorBanner severity="error">
            {loaded.detail} — the share link is still valid; this studio could not reach the engine
            that stores it. Reload in a moment.
          </ErrorBanner>
          <p className="mt-4 text-sm text-white/55">
            Nothing has been deleted: an unreadable backend is not a missing take, and this page
            will not claim otherwise.
          </p>
        </div>
      </TakeShell>
    );
  }
  const take = loaded.take;

  return (
    <TakeShell>
        <div className="pt-8">
          <TakeCard take={take} />
        </div>
        <TakeScore take={take} />

        {lineage && <Lineage lineage={lineage} />}
        <ReperformProvenance take={take} />
        <RePerform take={take} />
        <OpenInRack take={take} />

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
    </TakeShell>
  );
}
