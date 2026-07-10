"use client";

// Landing section: ElevenLabs bill calculator + the one-line switcher.
// Slide your monthly volume, see your current bill next to one Arm box
// running 24/7, and copy the base-URL diff that is the whole migration.

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  ARM_BOXES,
  CHARS_PER_AUDIO_MINUTE,
  estimateMonthly,
  fmtUsd,
  migrationSnippet,
  SNIPPET_LANGS,
  type SnippetLang,
} from "@/lib/switchkit";
import { SWITCH } from "@/lib/content";

const ease = [0.22, 1, 0.36, 1] as const;

// Slider is logarithmic: 10k chars (Free tier) → 20M chars (past Business).
const LOG_MIN = Math.log10(10_000);
const LOG_MAX = Math.log10(20_000_000);
const sliderToChars = (t: number) => Math.round(10 ** (LOG_MIN + (LOG_MAX - LOG_MIN) * t));

export default function SwitchKit() {
  const [t, setT] = useState(0.45); // ≈ Creator-tier volume by default
  const [lang, setLang] = useState<SnippetLang>("curl");
  const [copied, setCopied] = useState(false);

  const chars = sliderToChars(t);
  const est = useMemo(() => {
    const base = estimateMonthly(chars);
    return base.overCapacity ? estimateMonthly(chars, ARM_BOXES[1]) : base;
  }, [chars]);

  const snippet = migrationSnippet(lang);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the code is still selectable */
    }
  };

  return (
    <section id="switch" className="border-t border-white/5 py-14">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-60px" }}
        transition={{ duration: 0.7, ease }}
      >
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">{SWITCH.eyebrow}</span>
        <h2 className="font-instrument mt-2 text-3xl text-white">{SWITCH.headline}</h2>
        <p className="mt-2 max-w-2xl text-sm text-slate-300/80">{SWITCH.sub}</p>

        <div className="mt-8 grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
          {/* calculator */}
          <div className="glass-panel rounded-3xl p-6">
            <div className="flex items-baseline justify-between">
              <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">your monthly volume</span>
              <span className="font-jetbrains text-[12px] text-cyan-200">
                {chars.toLocaleString("en-US")} chars ≈ {Math.round(est.audioMinutes).toLocaleString("en-US")} min
              </span>
            </div>
            <input
              type="range" min={0} max={1} step={0.001} value={t}
              onChange={(e) => setT(Number(e.target.value))}
              aria-label="Monthly character volume"
              className="switch-slider mt-4 w-full"
            />

            <div className="mt-6 grid grid-cols-2 gap-4">
              <div className="rounded-2xl border border-white/8 bg-black/30 p-4">
                <div className="font-jetbrains text-[11px] uppercase tracking-wider text-white/55">
                  ElevenLabs · {est.elTier.name}
                </div>
                <div className="font-instrument mt-2 text-3xl text-white/90">{fmtUsd(est.elUsd)}<span className="text-base text-white/50">/mo</span></div>
              </div>
              <div className="rounded-2xl border border-cyan-400/25 bg-cyan-400/5 p-4">
                <div className="font-jetbrains text-[11px] uppercase tracking-wider text-cyan-200/80">{est.box.name}</div>
                <div className="font-instrument mt-2 text-3xl text-cyan-100">{fmtUsd(est.boxUsd)}<span className="text-base text-cyan-100/50">/mo</span></div>
              </div>
            </div>

            <div className="mt-4 flex items-baseline justify-between rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-4 py-3">
              <span className="font-jetbrains text-[11px] uppercase tracking-wider text-emerald-200/80">you keep</span>
              <span className="font-instrument text-2xl text-emerald-200">
                {fmtUsd(est.savingsUsd)}/mo · {fmtUsd(est.savingsYearUsd)}/yr
              </span>
            </div>
            <p className="font-jetbrains mt-3 text-[11px] leading-relaxed text-white/45">
              Arm box priced 24/7 on-demand; it serves up to {Math.round(est.boxCapacityMinutes).toLocaleString("en-US")} audio-min/mo.
              ElevenLabs list prices, ~{CHARS_PER_AUDIO_MINUTE.toLocaleString("en-US")} chars per audio minute.
            </p>
          </div>

          {/* one-line switcher */}
          <div className="glass-panel flex flex-col rounded-3xl p-6">
            <div className="flex items-center justify-between">
              <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">the whole migration</span>
              <div className="flex gap-1.5">
                {SNIPPET_LANGS.map((l) => (
                  <button
                    key={l} onClick={() => setLang(l)}
                    className={`font-jetbrains cursor-pointer rounded-full border px-2.5 py-1 text-[11px] transition ${
                      l === lang ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60 hover:text-white"
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <pre className="font-jetbrains mt-4 flex-1 overflow-x-auto rounded-2xl border border-white/8 bg-black/40 p-4 text-[12px] leading-relaxed text-cyan-100/90">
              {snippet}
            </pre>
            <div className="mt-4 flex items-center justify-between">
              <span className="font-jetbrains text-[11px] text-white/50">{SWITCH.note}</span>
              <button
                onClick={copy}
                className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-white/85 transition hover:bg-white/5"
              >
                {copied ? "✓ copied" : "copy snippet"}
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
