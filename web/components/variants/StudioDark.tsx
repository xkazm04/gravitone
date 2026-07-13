"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { BRAND, HERO, STATS, FEATURES, VOICES, SAMPLE_TEXT, API_DOCS_URL } from "@/lib/content";
import { useAuth } from "@/lib/useAuth";
import UserMenu from "@/components/ui/UserMenu";
import Equalizer, { usePauseOffscreen } from "@/components/ui/Equalizer";
import SwitchKit from "./SwitchKit";
import HeroMicDemo from "./HeroMicDemo";

const APP_ROUTES = [
  { label: "Playground", href: "/playground" },
  { label: "Voices", href: "/voices" },
  { label: "API keys", href: "/keys" },
];

const ease = [0.22, 1, 0.36, 1] as const;
const rise = {
  hidden: { opacity: 0, y: 24 },
  show: (i = 0) => ({ opacity: 1, y: 0, transition: { duration: 0.7, ease, delay: i * 0.08 } }),
};

export default function StudioDark() {
  const { user } = useAuth();
  const aurora = usePauseOffscreen<HTMLDivElement>();
  return (
    <div className="font-hanken relative min-h-screen overflow-hidden bg-[#080a10] text-slate-200 grain">
      {/* atmosphere — aurora drift pauses once scrolled past */}
      <div ref={aurora.ref} className={`pointer-events-none absolute inset-0 aurora ${aurora.paused ? "anim-paused" : ""}`} />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />

      <div className="relative mx-auto max-w-6xl px-6">
        {/* nav */}
        <nav className="flex items-center justify-between py-6">
          <Link href="/" aria-label="Gravitone home" className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/5">
              <Equalizer bars={4} className="h-4 scale-[0.7]" />
            </span>
            <span className="font-instrument text-2xl tracking-tight text-white">{BRAND}</span>
          </Link>
          {/* Signed-in users get route navigation; signed-out visitors get none
              (the marketing section anchors are removed for them). */}
          <div className="font-jetbrains hidden items-center gap-7 text-[13px] text-white/70 md:flex">
            {user &&
              APP_ROUTES.map((r) => (
                <Link key={r.href} href={r.href} className="transition hover:text-white">{r.label}</Link>
              ))}
          </div>
          <UserMenu />
        </nav>

        {/* hero */}
        <section className="grid items-center gap-12 pb-16 pt-10 lg:grid-cols-[1.05fr_0.95fr] lg:pt-16">
          <div>
            <motion.span
              variants={rise} initial="hidden" animate="show"
              className="font-jetbrains inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/5 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-cyan-300"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" /> {HERO.eyebrow}
            </motion.span>

            <motion.h1
              variants={rise} initial="hidden" animate="show" custom={1}
              className="font-instrument mt-6 text-[clamp(2.9rem,7vw,5.2rem)] leading-[0.98] tracking-tight text-white"
            >
              {HERO.headlinePlain}
              <br />
              <span className="text-aurora italic">{HERO.headlineAccent}</span>
            </motion.h1>

            <motion.p
              variants={rise} initial="hidden" animate="show" custom={2}
              className="mt-6 max-w-xl text-[17px] leading-relaxed text-slate-300/90"
            >
              {HERO.sub}
            </motion.p>

            <motion.div variants={rise} initial="hidden" animate="show" custom={3} className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/playground" className="cta-glow rounded-full bg-gradient-to-r from-cyan-300 to-cyan-200 px-6 py-3 text-sm font-semibold text-slate-950 transition hover:brightness-110">
                {HERO.primaryCta} →
              </Link>
              <a href={API_DOCS_URL} target="_blank" rel="noreferrer" className="font-jetbrains rounded-full border border-white/15 px-6 py-3 text-sm text-white/85 transition hover:bg-white/5">
                {HERO.secondaryCta}
              </a>
            </motion.div>

            <motion.div variants={rise} initial="hidden" animate="show" custom={4} className="mt-10 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
              {STATS.map((s) => (
                <div key={s.label}>
                  <div className="font-instrument text-2xl text-white">{s.value}</div>
                  <div className="font-jetbrains mt-1 text-[11px] uppercase tracking-wider text-white/65">{s.label}</div>
                </div>
              ))}
            </motion.div>
          </div>

          {/* hero panel = live mic demo: record ~16s, hear your cloned voice */}
          <HeroMicDemo />
        </section>

        {/* voices */}
        <section id="voices" className="border-t border-white/5 py-14">
          <div className="mb-6 flex items-end justify-between">
            <h2 className="font-instrument text-3xl text-white">A voice for every line.</h2>
            <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">27 built-in · ∞ cloned</span>
          </div>
          <div className="flex flex-wrap gap-3">
            {VOICES.map((v) => (
              <div key={v.name} className="glass-panel flex items-center gap-3 rounded-2xl px-4 py-3">
                <span className="h-8 w-8 rounded-full" style={{ background: `radial-gradient(circle at 30% 30%, hsl(${v.hue} 90% 70%), hsl(${v.hue} 80% 45%))`, boxShadow: `0 0 18px hsl(${v.hue} 90% 60% / .4)` }} />
                <div>
                  <div className="text-sm text-white">{v.name}</div>
                  <div className="font-jetbrains text-[11px] text-white/65">{v.tag}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* features */}
        <section id="api" className="grid gap-4 py-14 sm:grid-cols-2">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.key}
              variants={rise} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }} custom={i}
              className="glass-panel group rounded-2xl p-6 transition hover:border-cyan-400/30"
            >
              <div className="font-jetbrains text-[11px] text-cyan-300/70">0{i + 1}</div>
              <h3 className="font-instrument mt-2 text-xl text-white">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-300/80">{f.body}</p>
            </motion.div>
          ))}
        </section>

        {/* ElevenLabs switch kit: bill calculator + one-line switcher */}
        <SwitchKit />

        {/* playground teaser */}
        <section id="playground" className="py-14">
          <div className="glass-panel rounded-3xl p-8">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <span className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">free playground</span>
                <h2 className="font-instrument mt-2 text-3xl text-white">Type it. Hear it. Ship it.</h2>
                <p className="mt-2 max-w-md text-sm text-slate-300/80">Generate and download recordings from text for free — pick a voice, paste a script, and export a WAV.</p>
              </div>
              <div className="w-full max-w-md">
                <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
                  <p className="text-sm text-white/80">{SAMPLE_TEXT}</p>
                  <div className="mt-4 flex items-center justify-between">
                    <Equalizer bars={20} className="h-8" />
                    <Link
                      href={`/playground?text=${encodeURIComponent(SAMPLE_TEXT)}`}
                      className="cta-glow rounded-full bg-cyan-300 px-5 py-2 text-sm font-semibold text-slate-950 transition hover:brightness-110"
                    >
                      Generate
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* footer */}
        <footer className="flex flex-col items-center justify-between gap-4 border-t border-white/5 py-10 text-sm text-white/60 sm:flex-row">
          <span className="font-instrument text-lg text-white/70">{BRAND}</span>
          <Link href="/benchmarks" className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/70 transition hover:text-cyan-200">
            benchmarks — the receipts
          </Link>
          <span className="font-jetbrains text-[11px] uppercase tracking-widest">runs on arm · self-hostable · mit</span>
        </footer>
      </div>
    </div>
  );
}
