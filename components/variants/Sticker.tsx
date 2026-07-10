"use client";

import { motion } from "framer-motion";
import { BRAND, HERO, STATS, FEATURES, VOICES, SAMPLE_TEXT, NAV } from "@/lib/content";

const INK = "#17202a";
const spring = { type: "spring", stiffness: 120, damping: 14 } as const;

function pop(i = 0) {
  return {
    initial: { opacity: 0, y: 28, rotate: i % 2 ? -2 : 2 },
    whileInView: { opacity: 1, y: 0, rotate: 0 },
    viewport: { once: true, margin: "-50px" },
    transition: { ...spring, delay: i * 0.06 },
  };
}

export default function Sticker() {
  return (
    <div className="font-gabarito min-h-screen bg-[#fdf8ee] text-[#17202a]">
      <div className="mx-auto max-w-6xl px-6">
        {/* nav */}
        <nav className="flex items-center justify-between py-6">
          <div className="font-bricolage text-2xl font-extrabold tracking-tight">
            Gravi<span className="text-[#d65a4a]">tone</span>
          </div>
          <div className="hidden items-center gap-7 text-[15px] font-semibold text-[#42606f] md:flex">
            {NAV.map((n) => (
              <a key={n.label} href={n.href} className="transition hover:text-[#17202a]">{n.label}</a>
            ))}
          </div>
          <button className="btn-pop rounded-xl bg-[#caa54c] px-5 py-2 font-bold text-[#17202a]">Sign in</button>
        </nav>

        {/* hero */}
        <section className="grid items-center gap-10 py-12 lg:grid-cols-[1.12fr_0.88fr]">
          <div>
            <motion.span {...pop(0)} className="sticker inline-block -rotate-2 bg-[#dce7d0] px-4 py-1.5 text-sm font-bold">
              🎙️ CPU-native voice studio
            </motion.span>

            <motion.h1 {...pop(1)} className="font-bricolage mt-6 text-[clamp(2.8rem,7vw,5rem)] font-extrabold leading-[1.02]">
              {HERO.headlinePlain}
              <br />
              <span className="underline-draw text-[#d65a4a]">{HERO.headlineAccent}</span>
            </motion.h1>

            <motion.p {...pop(2)} className="mt-6 max-w-xl text-lg leading-relaxed text-[#42606f]">
              {HERO.sub}
            </motion.p>

            <motion.div {...pop(3)} className="mt-8 flex flex-wrap items-center gap-4">
              <a href="#playground" className="btn-pop rounded-xl bg-[#d65a4a] px-6 py-3 font-bold text-white">{HERO.primaryCta}</a>
              <a href="#api" className="btn-pop rounded-xl bg-white px-6 py-3 font-bold">{HERO.secondaryCta}</a>
            </motion.div>

            <motion.p {...pop(4)} className="font-shantell mt-6 text-lg text-[#526b4f]">
              ↳ clone your voice from a 16-second clip — no GPU, no bill.
            </motion.p>
          </div>

          {/* voice sticker stack */}
          <motion.div {...pop(2)} className="relative">
            <div className="sticker sticker-hover rotate-2 p-5">
              <div className="flex items-center justify-between">
                <span className="font-bricolage text-lg font-bold">Voice library</span>
                <span className="rounded-full bg-[#526b4f] px-2 py-0.5 text-xs font-bold text-white">27 + you</span>
              </div>
              <div className="mt-4 space-y-2">
                {VOICES.map((v) => (
                  <div key={v.name} className="flex items-center gap-3 rounded-xl border-[3px] border-[#17202a] bg-[#fdf8ee] px-3 py-2">
                    <span className="grid h-8 w-8 place-items-center rounded-full border-[3px] border-[#17202a] text-sm font-bold" style={{ background: `hsl(${v.hue} 70% 82%)` }}>▶</span>
                    <div className="flex-1">
                      <div className="font-bold leading-tight">{v.name}</div>
                      <div className="text-xs text-[#42606f]">{v.tag}</div>
                    </div>
                    <div className="flex items-end gap-[2px]" aria-hidden>
                      {[8, 14, 6, 16, 10].map((h, i) => (
                        <span key={i} className="eq-bar w-[3px] rounded-sm bg-[#d65a4a]" style={{ height: h, animationDelay: `${i * 0.1}s` }} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="font-shantell absolute -bottom-8 -left-4 rotate-[-6deg] text-[#d65a4a]">your voice, on tap →</div>
          </motion.div>
        </section>
      </div>

      {/* coral marquee band */}
      <div className="border-y-[3px] border-[#17202a] bg-[#d65a4a] py-3 text-white">
        <div className="flex whitespace-nowrap">
          <div className="marquee font-bricolage flex gap-8 pr-8 text-xl font-extrabold">
            {Array.from({ length: 2 }).map((_, k) => (
              <span key={k} className="flex gap-8">
                {["CLONE ANY VOICE", "ELEVENLABS-COMPATIBLE API", "RUNS ON ARM CPU", "FREE PLAYGROUND", "SELF-HOSTABLE", "NO GPU"].map((t) => (
                  <span key={t}>★ {t}</span>
                ))}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* features on lime band */}
      <div className="border-b-[3px] border-[#17202a] bg-[#dce7d0]">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="font-bricolage text-4xl font-extrabold">Everything a voice studio needs.</h2>
          <div className="mt-8 grid gap-5 md:grid-cols-2">
            {FEATURES.map((f, i) => (
              <motion.div key={f.key} {...pop(i)} className="sticker sticker-hover p-6" style={{ rotate: `${i % 2 ? 1 : -1}deg` }}>
                <div className="font-bricolage text-xl font-extrabold">{f.title}</div>
                <p className="mt-2 text-[#42606f]">{f.body}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </div>

      {/* stats + playground */}
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          {STATS.map((s, i) => (
            <motion.div key={s.label} {...pop(i)} className="sticker p-5 text-center" style={{ rotate: `${i % 2 ? -1.5 : 1.5}deg` }}>
              <div className="font-bricolage text-3xl font-extrabold text-[#d65a4a]">{s.value}</div>
              <div className="mt-1 text-sm font-semibold text-[#42606f]">{s.label}</div>
            </motion.div>
          ))}
        </div>

        <div id="playground" className="mt-14">
          <div className="sticker overflow-hidden p-0">
            <div className="border-b-[3px] border-[#17202a] bg-[#caa54c] px-6 py-3 font-bricolage font-extrabold">Free playground</div>
            <div className="grid gap-6 p-6 md:grid-cols-[1fr_auto] md:items-center">
              <div>
                <p className="font-shantell text-xl text-[#526b4f]">paste a script, pick a voice, hit generate →</p>
                <div className="mt-3 rounded-xl border-[3px] border-[#17202a] bg-[#fdf8ee] p-4 text-[#42606f]">{SAMPLE_TEXT}</div>
              </div>
              <button className="btn-pop rounded-xl bg-[#d65a4a] px-8 py-4 font-bold text-white">Generate ▶</button>
            </div>
          </div>
        </div>
      </div>

      {/* footer */}
      <footer className="border-t-[3px] border-[#17202a] bg-[#17202a] py-10 text-[#fdf8ee]">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 sm:flex-row">
          <span className="font-bricolage text-xl font-extrabold">Gravi<span className="text-[#d65a4a]">tone</span></span>
          <span className="font-shantell text-lg">made to run anywhere · MIT</span>
        </div>
      </footer>
    </div>
  );
}
