"use client";

// Hero mic demo — the landing's live proof. A visitor reads ~16 seconds into
// the mic, the CPU backend clones the voice, and SAMPLE_TEXT plays back in
// THEIR voice — no account required. The demo character is deleted right
// after synthesis; keeping voices is the sign-in hook.
//
// This component IS the hero glass panel: idle state renders the decorative
// "now generating" card, the demo states take it over.
//
// The recorder, the pipeline and the phase they move through live in
// ./useHeroMicDemo; what is left here is the panel each phase draws.

import { motion } from "framer-motion";
import { HERO_DEMO, SAMPLE_TEXT } from "@/lib/content";
import { useAuth } from "@/lib/useAuth";
import Equalizer from "@/components/ui/Equalizer";
import TakePlayer from "@/components/ui/TakePlayer";
import { EASE } from "@/components/ui/tokens";
import { MAX_SECONDS, MIN_SECONDS, useHeroMicDemo } from "./useHeroMicDemo";

export default function HeroMicDemo() {
  const { ready, signIn } = useAuth();
  const { phase, setPhase, seconds, error, audioUrl, startRecording, stopRecording, cancel } =
    useHeroMicDemo();

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.9, ease: EASE, delay: 0.2 }}
      className="glass-panel relative rounded-3xl p-6 shadow-2xl"
    >
      <div className="flex items-center justify-between">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">
          {phase === "idle" && "● now generating"}
          {phase === "recording" && "● recording you"}
          {(phase === "cloning" || phase === "rendering") && "● cloning on cpu"}
          {phase === "ready" && "● your voice, cloned"}
          {phase === "error" && "● demo hiccup"}
        </span>
        <span className="font-jetbrains text-[11px] text-white/60">24kHz · cpu</span>
      </div>

      {phase === "idle" && (
        <>
          <p className="font-instrument mt-5 text-xl italic leading-snug text-white/90">“{SAMPLE_TEXT}”</p>
          <div className="mt-6 rounded-2xl border border-white/8 bg-black/30 p-5">
            <Equalizer bars={40} className="h-16" />
            <div className="mt-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-full bg-cyan-300 text-slate-950">▶</span>
                <div>
                  <div className="text-sm text-white">Your voice</div>
                  <div className="font-jetbrains text-[11px] text-white/60">cloned · 16s sample</div>
                </div>
              </div>
              <button
                onClick={() => void startRecording()}
                className="cta-glow cursor-pointer rounded-full bg-gradient-to-r from-cyan-300 to-cyan-200 px-4 py-2 text-[13px] font-semibold text-slate-950 transition hover:brightness-110"
              >
                🎙 {HERO_DEMO.cta}
              </button>
            </div>
          </div>
        </>
      )}

      {phase === "recording" && (
        <>
          <p className="mt-4 text-sm text-white/65">Read this naturally — stop any time after {MIN_SECONDS}s:</p>
          <blockquote className="font-hanken mt-3 rounded-2xl border border-white/8 bg-black/30 p-4 text-[15px] leading-relaxed text-white/90">
            {HERO_DEMO.readScript}
          </blockquote>
          {/* These bars are the live mic, not a CSS timer — the visitor can see
              the studio hearing them before they trust it with a clone. */}
          <Equalizer bars={40} className="mt-4 h-10" />
          <div className="mt-4 flex items-center justify-between">
            <span className="font-jetbrains inline-flex items-center gap-2 text-[13px] text-rose-300">
              <span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" /> {seconds}s / {MAX_SECONDS}s
            </span>
            <button
              onClick={stopRecording}
              disabled={seconds < MIN_SECONDS}
              className="cursor-pointer rounded-full bg-cyan-300 px-4 py-2 text-[13px] font-semibold text-slate-950 transition hover:brightness-110 disabled:opacity-40"
            >
              ■ Stop & clone
            </button>
          </div>
        </>
      )}

      {(phase === "cloning" || phase === "rendering") && (
        <div className="mt-6 rounded-2xl border border-white/8 bg-black/30 p-5">
          <Equalizer bars={40} className="h-16" />
          <p className="font-jetbrains mt-4 text-[12px] text-cyan-300">
            {phase === "cloning" ? "cloning your voice on the CPU…" : "rendering your line…"}
          </p>
          <p className="font-jetbrains mt-1 text-[11px] text-white/50">no GPU involved — this is the whole pitch</p>
          <button onClick={cancel}
            className="font-jetbrains mt-4 cursor-pointer rounded-full border border-white/15 px-4 py-1.5 text-[12px] text-white/70 transition hover:bg-white/5">
            Cancel
          </button>
        </div>
      )}

      {phase === "ready" && audioUrl && (
        <>
          <p className="font-instrument mt-5 text-xl italic leading-snug text-white/90">“{SAMPLE_TEXT}”</p>
          <div className="mt-4 rounded-2xl border border-cyan-400/20 bg-black/30 p-5">
            {/* Obsidian transport, not browser chrome — and registered on the
                bus, so the bars beside it move with the cloned voice. */}
            <TakePlayer src={audioUrl} autoPlay label="your cloned voice" className="w-full" />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <span className="font-jetbrains text-[11px] text-white/55">{HERO_DEMO.note}</span>
              <div className="flex gap-2">
                {ready && (
                  <button onClick={() => void signIn()}
                    className="cta-glow cursor-pointer rounded-full bg-gradient-to-r from-cyan-300 to-cyan-200 px-4 py-2 text-[12px] font-semibold text-slate-950 transition hover:brightness-110">
                    {HERO_DEMO.keepCta}
                  </button>
                )}
                <button onClick={() => setPhase("idle")}
                  className="font-jetbrains cursor-pointer rounded-full border border-white/15 px-3 py-2 text-[12px] text-white/80 transition hover:bg-white/5">
                  again
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {phase === "error" && (
        <div className="mt-5 rounded-2xl border border-amber-400/20 bg-amber-400/5 p-5">
          <p className="text-sm text-amber-200/90">{error}</p>
          <button onClick={() => setPhase("idle")}
            className="font-jetbrains mt-3 cursor-pointer rounded-full border border-white/15 px-3 py-1.5 text-[12px] text-white/80 transition hover:bg-white/5">
            ← back
          </button>
        </div>
      )}
    </motion.div>
  );
}
