"use client";

import { motion } from "framer-motion";
import { BRAND, HERO, STATS, FEATURES, VOICES, SAMPLE_TEXT, NAV } from "@/lib/content";

const ease = [0.16, 1, 0.3, 1] as const;
const up = {
  hidden: { opacity: 0, y: 18 },
  show: (i = 0) => ({ opacity: 1, y: 0, transition: { duration: 0.6, ease, delay: i * 0.07 } }),
};

// a scope-like waveform path
const SCOPE_PATH =
  "M0,60 C40,60 40,20 80,20 S120,100 160,100 200,30 240,30 280,90 320,90 360,45 400,60 440,15 480,60 520,100 560,55 600,60";

function CornerTicks() {
  return (
    <>
      <span className="absolute left-0 top-0 h-2 w-2 border-l border-t border-emerald-400/60" />
      <span className="absolute right-0 top-0 h-2 w-2 border-r border-t border-emerald-400/60" />
      <span className="absolute bottom-0 left-0 h-2 w-2 border-b border-l border-emerald-400/60" />
      <span className="absolute bottom-0 right-0 h-2 w-2 border-b border-r border-emerald-400/60" />
    </>
  );
}

export default function Silicon() {
  return (
    <div className="font-hanken min-h-screen bg-[#06090b] text-slate-300">
      {/* faint graph paper */}
      <div className="pointer-events-none fixed inset-0 grid-paper opacity-60" />

      <div className="relative mx-auto max-w-6xl px-6">
        {/* nav */}
        <nav className="flex items-center justify-between border-b border-white/5 py-5">
          <div className="font-jetbrains flex items-center gap-1 text-lg text-white">
            {BRAND.toLowerCase()}<span className="cursor-blink text-emerald-400">_</span>
          </div>
          <div className="font-jetbrains hidden items-center gap-7 text-[12px] text-white/50 md:flex">
            {NAV.map((n) => (
              <a key={n.label} href={n.href} className="transition hover:text-emerald-400">/{n.label.toLowerCase()}</a>
            ))}
          </div>
          <button className="font-jetbrains chip-tech rounded px-4 py-1.5 text-[12px]">&gt; connect</button>
        </nav>

        {/* hero */}
        <section className="grid items-center gap-12 py-16 lg:grid-cols-[1fr_1fr]">
          <div>
            <motion.div variants={up} initial="hidden" animate="show" className="font-jetbrains text-[12px] tracking-[0.2em] text-emerald-400">
              // {HERO.eyebrow.toUpperCase()}
            </motion.div>
            <motion.h1 variants={up} initial="hidden" animate="show" custom={1} className="mt-5 text-[clamp(2.6rem,6.5vw,4.6rem)] font-extrabold leading-[1.02] tracking-tight text-white">
              {HERO.headlinePlain}{" "}
              <span className="relative whitespace-nowrap text-emerald-400">
                {HERO.headlineAccent}
                <span className="absolute -bottom-1 left-0 h-px w-full bg-emerald-400/50" />
              </span>
            </motion.h1>
            <motion.p variants={up} initial="hidden" animate="show" custom={2} className="mt-6 max-w-lg leading-relaxed text-slate-400">
              {HERO.sub}
            </motion.p>
            <motion.div variants={up} initial="hidden" animate="show" custom={3} className="mt-8 flex flex-wrap gap-3">
              <a href="#playground" className="font-jetbrains rounded bg-emerald-400 px-6 py-3 text-[13px] font-semibold text-[#06090b] transition hover:bg-emerald-300">{HERO.primaryCta} →</a>
              <a href="#api" className="font-jetbrains chip-tech rounded px-6 py-3 text-[13px]">{HERO.secondaryCta}</a>
            </motion.div>
          </div>

          {/* oscilloscope panel */}
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.8, ease, delay: 0.15 }}
            className="scanlines relative overflow-hidden rounded-md border border-emerald-400/25 bg-[#03110d] p-5"
          >
            <CornerTicks />
            <div className="font-jetbrains flex items-center justify-between text-[11px] text-emerald-400/80">
              <span>SCOPE · your voice</span>
              <span className="text-emerald-400/50">24.0kHz / cpu</span>
            </div>
            <svg viewBox="0 0 600 120" className="mt-3 h-40 w-full">
              <path d="M0,60 H600 M0,20 H600 M0,100 H600" stroke="rgba(16,185,129,0.15)" />
              <path d={SCOPE_PATH} fill="none" stroke="#34d399" strokeWidth="2" className="scope-trace" style={{ filter: "drop-shadow(0 0 6px rgba(52,211,153,0.7))" }} />
            </svg>
            <div className="font-jetbrains mt-3 grid grid-cols-3 gap-2 text-[11px]">
              {[["rtf", "1.90×"], ["first-chunk", "198ms"], ["cores", "2"]].map(([k, v]) => (
                <div key={k} className="rounded border border-white/8 bg-black/30 px-2 py-1.5">
                  <div className="text-white/40">{k}</div>
                  <div className="text-emerald-400">{v}</div>
                </div>
              ))}
            </div>
          </motion.div>
        </section>

        {/* datasheet stat strip */}
        <section className="grid grid-cols-2 divide-white/5 border-y border-white/10 py-8 sm:grid-cols-4 sm:divide-x">
          {STATS.map((s) => (
            <div key={s.label} className="px-4 first:pl-0">
              <div className="font-jetbrains text-3xl font-semibold text-white">{s.value}</div>
              <div className="font-jetbrains mt-1 text-[11px] uppercase tracking-wider text-emerald-400/70">{s.label}</div>
            </div>
          ))}
        </section>

        {/* feature spec cells */}
        <section id="api" className="grid gap-px overflow-hidden rounded-md border border-white/10 bg-white/5 py-0 sm:grid-cols-2 my-14">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.key} variants={up} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-50px" }} custom={i}
              className="relative bg-[#06090b] p-7 transition hover:bg-[#0a1310]"
            >
              <div className="font-jetbrains text-[11px] text-emerald-400/60">SPEC.0{i + 1}</div>
              <h3 className="mt-2 text-lg font-bold text-white">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{f.body}</p>
            </motion.div>
          ))}
        </section>

        {/* voices as signal chips */}
        <section id="voices" className="pb-14">
          <div className="font-jetbrains mb-4 text-[12px] tracking-[0.2em] text-emerald-400">// VOICE_BANK</div>
          <div className="flex flex-wrap gap-2">
            {VOICES.map((v) => (
              <div key={v.name} className="font-jetbrains flex items-center gap-2 rounded border border-white/10 bg-white/[0.02] px-3 py-2 text-[12px]">
                <span className="h-2 w-2 rounded-full" style={{ background: `hsl(${v.hue} 80% 55%)`, boxShadow: `0 0 8px hsl(${v.hue} 80% 55%)` }} />
                <span className="text-white">{v.name}</span>
                <span className="text-white/35">{v.tag}</span>
              </div>
            ))}
          </div>
        </section>

        {/* terminal playground */}
        <section id="playground" className="pb-16">
          <div className="scanlines overflow-hidden rounded-md border border-emerald-400/25 bg-[#03110d]">
            <div className="font-jetbrains flex items-center gap-2 border-b border-emerald-400/20 px-4 py-2 text-[11px] text-white/40">
              <span className="h-2.5 w-2.5 rounded-full bg-[#d65a4a]/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#caa54c]/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
              <span className="ml-2">playground — free</span>
            </div>
            <div className="font-jetbrains space-y-2 p-5 text-[13px]">
              <div><span className="text-emerald-400">$</span> <span className="text-white">gravitone say</span> --voice alba \</div>
              <div className="pl-6 text-slate-400">&quot;{SAMPLE_TEXT}&quot;</div>
              <div className="flex items-center justify-between pt-2">
                <span className="text-emerald-400/70">→ rendering 24kHz wav … <span className="cursor-blink">▮</span></span>
                <button className="rounded bg-emerald-400 px-5 py-2 text-[12px] font-semibold text-[#06090b] transition hover:bg-emerald-300">generate ▶</button>
              </div>
            </div>
          </div>
        </section>

        {/* footer */}
        <footer className="font-jetbrains flex flex-col items-center justify-between gap-3 border-t border-white/10 py-8 text-[11px] text-white/40 sm:flex-row">
          <span className="text-white/70">{BRAND.toLowerCase()}<span className="text-emerald-400">_</span></span>
          <span className="tracking-widest">ARM NEOVERSE · ONEDNN+ACL · MIT</span>
        </footer>
      </div>
    </div>
  );
}
