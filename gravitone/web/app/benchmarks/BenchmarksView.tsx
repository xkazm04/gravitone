"use client";

// Public benchmark page: the cost-per-audio-hour leaderboard (measured
// Gravitone boxes vs ElevenLabs list tiers), a live proof strip from this
// deployment's /health metrics, the capacity planner, and the methodology
// that makes every number reproducible.

import Link from "next/link";
import { motion } from "framer-motion";
import { Wordmark } from "@/components/ui/Primitives";
import { useHealthPoll } from "@/lib/useHealthPoll";
import { HARNESS } from "@/lib/benchmarks";
import {
  ELEVENLABS_PRICING,
  ELEVENLABS_PRICING_NOTE,
} from "@/lib/switchkit";
import BenchmarksLeaderboard from "./BenchmarksLeaderboard";
import BenchmarksPlanner from "./BenchmarksPlanner";
import LocalEnginePanel from "./LocalEnginePanel";

const ease = [0.22, 1, 0.36, 1] as const;
const rise = {
  hidden: { opacity: 0, y: 24 },
  show: (i = 0) => ({ opacity: 1, y: 0, transition: { duration: 0.7, ease, delay: i * 0.08 } }),
};

type Health = { status?: string; metrics?: { realtime_factor?: number | null; audio_seconds_total?: number } };

export default function BenchmarksView() {
  // live proof strip — shared poller (SavingsTicker polls the same endpoint)
  const { health: live, stale: liveStale } = useHealthPoll();

  return (
    <div className="font-hanken relative min-h-screen overflow-hidden bg-[#080a10] text-slate-200 grain">
      <div className="pointer-events-none absolute inset-0 aurora" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />

      <div className="relative mx-auto max-w-5xl px-6 pb-24">
        <nav className="flex items-center justify-between py-6">
          <Link href="/" aria-label="Gravitone home"><Wordmark /></Link>
          <Link href="/" className="font-jetbrains rounded-full border border-white/15 px-4 py-1.5 text-[12px] text-white/85 transition hover:bg-white/5">
            open the studio →
          </Link>
        </nav>

        {/* hero */}
        <motion.header variants={rise} initial="hidden" animate="show" className="pt-8">
          <span className="font-jetbrains inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/5 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-cyan-300">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" /> measured, reproducible
          </span>
          <h1 className="font-instrument mt-5 text-[clamp(2.4rem,6vw,4rem)] leading-tight tracking-tight text-white">
            Dollars per audio-hour.<br />
            <span className="text-aurora italic">Receipts included.</span>
          </h1>
          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-slate-300/90">
            Every Gravitone number below comes from the open benchmark harness in the repo — run it on any
            Arm box and get your own row. ElevenLabs numbers are their public list prices, as published{" "}
            {ELEVENLABS_PRICING.asOfLabel}.
          </p>
        </motion.header>

        {/* live proof strip */}
        {live?.metrics && (
          <div className="font-jetbrains mt-6 inline-flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-4 py-2 text-[12px] text-emerald-200/90">
            <span className="inline-flex items-center gap-2">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" /> this deployment, live:
            </span>
            {typeof live.metrics.realtime_factor === "number" && (
              <span>{live.metrics.realtime_factor}× realtime</span>
            )}
            {typeof live.metrics.audio_seconds_total === "number" && live.metrics.audio_seconds_total > 0 && (
              <span>{Math.round(live.metrics.audio_seconds_total / 60).toLocaleString("en-US")} min served lifetime</span>
            )}
            <span className="text-emerald-200/60">CPU only — no GPU attached</span>
          </div>
        )}

        {/* leaderboard */}
        <motion.section variants={rise} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }} className="mt-12">
          <BenchmarksLeaderboard />
        </motion.section>

        {/* capacity planner */}
        <motion.section id="planner" variants={rise} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }} className="mt-14">
          <BenchmarksPlanner />
        </motion.section>

        {/* methodology */}
        <motion.section variants={rise} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }} className="mt-14">
          <h2 className="font-instrument text-2xl text-white">Methodology — run it yourself</h2>
          <div className="glass-panel mt-4 rounded-3xl p-6">
            <ul className="space-y-2 text-sm text-slate-300/85">
              <li><span className="font-jetbrains text-cyan-300">harness</span> — {HARNESS.method}</li>
              <li><span className="font-jetbrains text-cyan-300">runtime</span> — {HARNESS.torch}</li>
              <li><span className="font-jetbrains text-cyan-300">measured</span> — {HARNESS.measured}</li>
              <li>
                <span className="font-jetbrains text-cyan-300">pricing</span> — AWS on-demand list;
                ~1,000 chars ≈ 1 audio-minute. {ELEVENLABS_PRICING_NOTE} — source:{" "}
                <a
                  href={ELEVENLABS_PRICING.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline-offset-2 transition hover:text-cyan-200 hover:underline"
                >
                  {ELEVENLABS_PRICING.sourceLabel}
                </a>
              </li>
            </ul>
            <pre className="font-jetbrains mt-4 overflow-x-auto rounded-2xl border border-white/8 bg-black/40 p-4 text-[12px] leading-relaxed text-cyan-100/90">
{`# any Arm64 Linux box — Graviton, Axion, Ampere, or your laptop
git clone <repo> && cd gravitone/gravitone
bash benchmark_arm.sh          # ramps concurrency, finds the knee
# → service/loadtest_result.json (open a PR to add your row)

# liked the numbers? deploy your own Private ElevenLabs in one command:
deploy/aws-oneclick.sh up      # → base URL + xi-api-key (see deploy/README.md)`}
            </pre>
            <p className="font-jetbrains mt-3 text-[11px] text-white/45">
              Community rows welcome — every submitted result JSON grows the sizing corpus behind the planner above.
            </p>
          </div>
        </motion.section>

        {/* where the audio is made — the page's last honest number is not a
            price but a location. */}
        <motion.section variants={rise} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }} className="mt-14">
          <h2 className="font-instrument text-2xl text-white">Where the synthesis runs</h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-300/80">
            Every number above is a server cost, because every byte of audio here is made on a server.
            A CPU-sized model is small enough to ask a harder question: could the browser do it instead?
          </p>
          <LocalEnginePanel />
        </motion.section>

        <footer className="mt-16 flex flex-col items-center justify-between gap-4 border-t border-white/5 pt-8 text-sm text-white/60 sm:flex-row">
          <Link href="/" className="font-instrument text-lg text-white/70 transition hover:text-white">Gravitone</Link>
          <span className="font-jetbrains text-[11px] uppercase tracking-widest">runs on arm · self-hostable · mit</span>
        </footer>
      </div>
    </div>
  );
}
