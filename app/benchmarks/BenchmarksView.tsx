"use client";

// Public benchmark page: the cost-per-audio-hour leaderboard (measured
// Gravitone boxes vs ElevenLabs list tiers), a live proof strip from this
// deployment's /health metrics, the capacity planner, and the methodology
// that makes every number reproducible.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Wordmark } from "@/components/ui/Primitives";
import {
  BENCHMARKS,
  boxCapacityAudPerS,
  costPerAudioHour,
  elCostPerAudioHour,
  HARNESS,
  planCapacity,
  planEnvBlock,
} from "@/lib/benchmarks";
import { ELEVENLABS_TIERS, fmtUsd } from "@/lib/switchkit";

const ease = [0.22, 1, 0.36, 1] as const;
const rise = {
  hidden: { opacity: 0, y: 24 },
  show: (i = 0) => ({ opacity: 1, y: 0, transition: { duration: 0.7, ease, delay: i * 0.08 } }),
};

type Row = {
  name: string;
  detail: string;
  usdPerAudioHour: number;
  isGravitone: boolean;
};

function buildRows(): Row[] {
  const g: Row[] = BENCHMARKS.filter((b) => b.instance && b.usdPerHour != null).map((b) => ({
    name: `Gravitone · ${b.instance}`,
    detail: `${b.platform} ${b.cpu} · ${boxCapacityAudPerS(b)} aud/s · ${b.notes}`,
    usdPerAudioHour: costPerAudioHour(b)!,
    isGravitone: true,
  }));
  const el: Row[] = ELEVENLABS_TIERS.map((t) => ({ t, c: elCostPerAudioHour(t.name) }))
    .filter((x): x is { t: (typeof ELEVENLABS_TIERS)[number]; c: number } => x.c != null)
    .map(({ t, c }) => ({
      name: `ElevenLabs · ${t.name}`,
      detail: `${fmtUsd(t.usdPerMonth)}/mo for ${(t.charsPerMonth / 1000).toLocaleString("en-US")}k chars (list price)`,
      usdPerAudioHour: c,
      isGravitone: false,
    }));
  return [...g, ...el].sort((a, b) => a.usdPerAudioHour - b.usdPerAudioHour);
}

// Bars span ~3 orders of magnitude — lay them out on a log scale.
function logWidth(usd: number, min: number, max: number): number {
  const lo = Math.log10(min), hi = Math.log10(max);
  return 6 + 94 * ((Math.log10(usd) - lo) / (hi - lo || 1));
}

type Health = { status?: string; metrics?: { realtime_factor?: number | null; audio_seconds_total?: number } };

export default function BenchmarksView() {
  const rows = useMemo(buildRows, []);
  const minC = rows[0].usdPerAudioHour;
  const maxC = rows[rows.length - 1].usdPerAudioHour;
  const cheapestEl = rows.filter((r) => !r.isGravitone)[0];

  // live proof strip
  const [live, setLive] = useState<Health | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        if (r.ok && alive) setLive((await r.json()) as Health);
      } catch { /* backend away */ }
    };
    void poll();
    const id = setInterval(poll, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // capacity planner
  const [streams, setStreams] = useState(4);
  const [dailyMin, setDailyMin] = useState(600);
  const plan = useMemo(() => planCapacity(streams, dailyMin), [streams, dailyMin]);
  const [copied, setCopied] = useState(false);
  const copyEnv = async () => {
    try {
      await navigator.clipboard.writeText(planEnvBlock(plan));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* selectable anyway */ }
  };

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
            Arm box and get your own row. ElevenLabs numbers are their public list prices.
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
          <h2 className="font-instrument text-2xl text-white">Cost per audio-hour (log scale)</h2>
          <div className="glass-panel mt-4 rounded-3xl p-6">
            <div className="space-y-4">
              {rows.map((r) => {
                const ratio = r.isGravitone ? cheapestEl.usdPerAudioHour / r.usdPerAudioHour : null;
                return (
                  <div key={r.name}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className={`text-sm ${r.isGravitone ? "text-cyan-100" : "text-white/75"}`}>{r.name}</span>
                      <span className="font-jetbrains shrink-0 text-[12px] text-white/80">
                        {r.usdPerAudioHour < 0.1 ? `$${r.usdPerAudioHour.toFixed(4)}` : fmtUsd(r.usdPerAudioHour)}/audio-h
                        {ratio && ratio > 2 && (
                          <span className="ml-2 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-200">
                            {Math.round(ratio).toLocaleString("en-US")}× under {cheapestEl.name.replace("ElevenLabs · ", "EL ")}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-white/5">
                      <div
                        className={`h-full rounded-full ${r.isGravitone ? "bg-gradient-to-r from-cyan-400 to-emerald-300" : "bg-white/25"}`}
                        style={{ width: `${logWidth(r.usdPerAudioHour, minC, maxC)}%` }}
                      />
                    </div>
                    <div className="font-jetbrains mt-1 text-[11px] text-white/45">{r.detail}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </motion.section>

        {/* capacity planner */}
        <motion.section id="planner" variants={rise} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }} className="mt-14">
          <h2 className="font-instrument text-2xl text-white">What box do I need?</h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-300/80">
            Sized from the measured knee data, using the scaling law the benchmarks surfaced: run
            single-worker processes, not in-process threads.
          </p>

          <div className="mt-4 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="glass-panel rounded-3xl p-6">
              <label className="block">
                <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">peak concurrent streams</span>
                <input
                  type="number" min={1} max={500} value={streams}
                  onChange={(e) => setStreams(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
                  className="font-jetbrains mt-2 w-full rounded-xl border border-white/12 bg-white/[0.03] px-4 py-2.5 text-base text-white focus:border-cyan-400/40 focus:outline-none"
                />
              </label>
              <label className="mt-5 block">
                <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">daily audio minutes</span>
                <input
                  type="number" min={0} max={1_000_000} value={dailyMin}
                  onChange={(e) => setDailyMin(Math.max(0, Math.min(1_000_000, Number(e.target.value) || 0)))}
                  className="font-jetbrains mt-2 w-full rounded-xl border border-white/12 bg-white/[0.03] px-4 py-2.5 text-base text-white focus:border-cyan-400/40 focus:outline-none"
                />
              </label>
              <p className="font-jetbrains mt-4 text-[11px] leading-relaxed text-white/45">
                Provisioned for max(streams, 4× the daily average arrival rate) = {plan.need.audPerS.toFixed(1)} audio-s/s.
              </p>
            </div>

            <div className="glass-panel rounded-3xl p-6">
              <div className="flex items-baseline justify-between">
                <span className="font-instrument text-xl text-white">
                  {plan.instances}× {plan.box.instance}
                </span>
                <span className="font-instrument text-2xl text-cyan-100">
                  {fmtUsd(plan.monthlyUsd)}<span className="text-sm text-cyan-100/50">/mo 24·7</span>
                </span>
              </div>
              <div className="font-jetbrains mt-1 text-[11px] text-white/55">
                {plan.box.platform} {plan.box.cpu} · {plan.replicas} processes · {plan.headroomPct}% headroom
                {plan.elMonthlyUsd != null && plan.elMonthlyUsd > plan.monthlyUsd && (
                  <span className="ml-2 text-emerald-300">
                    same volume ≈ {fmtUsd(plan.elMonthlyUsd)}/mo at ElevenLabs
                  </span>
                )}
              </div>
              <pre className="font-jetbrains mt-4 overflow-x-auto rounded-2xl border border-white/8 bg-black/40 p-4 text-[11px] leading-relaxed text-cyan-100/90">
                {planEnvBlock(plan)}
              </pre>
              <button onClick={copyEnv}
                className="font-jetbrains mt-3 cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-white/85 transition hover:bg-white/5">
                {copied ? "✓ copied" : "copy env config"}
              </button>
            </div>
          </div>
        </motion.section>

        {/* methodology */}
        <motion.section variants={rise} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }} className="mt-14">
          <h2 className="font-instrument text-2xl text-white">Methodology — run it yourself</h2>
          <div className="glass-panel mt-4 rounded-3xl p-6">
            <ul className="space-y-2 text-sm text-slate-300/85">
              <li><span className="font-jetbrains text-cyan-300">harness</span> — {HARNESS.method}</li>
              <li><span className="font-jetbrains text-cyan-300">runtime</span> — {HARNESS.torch}</li>
              <li><span className="font-jetbrains text-cyan-300">measured</span> — {HARNESS.measured}</li>
              <li><span className="font-jetbrains text-cyan-300">pricing</span> — AWS on-demand list; ElevenLabs public tiers, ~1,000 chars ≈ 1 audio-minute</li>
            </ul>
            <pre className="font-jetbrains mt-4 overflow-x-auto rounded-2xl border border-white/8 bg-black/40 p-4 text-[12px] leading-relaxed text-cyan-100/90">
{`# any Arm64 Linux box — Graviton, Axion, Ampere, or your laptop
git clone <repo> && cd gravitone
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

        <footer className="mt-16 flex flex-col items-center justify-between gap-4 border-t border-white/5 pt-8 text-sm text-white/60 sm:flex-row">
          <Link href="/" className="font-instrument text-lg text-white/70 transition hover:text-white">Gravitone</Link>
          <span className="font-jetbrains text-[11px] uppercase tracking-widest">runs on arm · self-hostable · mit</span>
        </footer>
      </div>
    </div>
  );
}
