"use client";

// STAGE — performer metaphor. The chosen voice is a lit performer center-stage;
// the text is a "script"; generating is "recording a take"; results stack like a
// session. Spacious, cinematic, emotional. Different from Console (operator/dense).

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import { EASE } from "@/components/ui/tokens";
import { VOICES, fakeGenerate, waveHeights, DEFAULT_TEXT, type Take, type Voice } from "./shared";

function GlowWave({ seed, hue, playing, className = "" }: { seed: number; hue: number; playing?: boolean; className?: string }) {
  return (
    <div className={`flex items-center gap-[3px] ${className}`} aria-hidden>
      {waveHeights(seed, 40).map((h, i) => (
        <span
          key={i}
          className={`w-[3px] rounded-full ${playing ? "eq-bar" : ""}`}
          style={{
            height: `${Math.round(h * 100)}%`,
            background: `hsl(${hue} 90% 65%)`,
            boxShadow: `0 0 8px hsl(${hue} 90% 60% / .5)`,
            animationDelay: `${(i % 6) * 0.09}s`,
          }}
        />
      ))}
    </div>
  );
}

function Performer({ voice, active }: { voice: Voice; active: boolean }) {
  return (
    <div className="relative grid place-items-center">
      <motion.div
        initial={false}
        animate={{ scale: active ? 1.04 : 1 }}
        transition={{ duration: 0.6, ease: EASE }}
        className="grid h-40 w-40 place-items-center rounded-full"
        style={{
          background: `radial-gradient(circle at 35% 30%, hsl(${voice.hue} 90% 68%), hsl(${voice.hue} 80% 38%))`,
          boxShadow: `0 0 70px hsl(${voice.hue} 90% 55% / .45)`,
        }}
      >
        <GlowWave seed={voice.hue * 7} hue={voice.hue} playing={active} className="h-16" />
      </motion.div>
      <div className="mt-5 text-center">
        <div className="font-instrument text-2xl text-white">{voice.name}</div>
        <div className="font-jetbrains mt-1 text-[11px] uppercase tracking-widest text-white/50">
          {voice.source === "cloned" ? `cloned · ${voice.sample}` : "built-in"} · {voice.lang} · {voice.rtf}× realtime
        </div>
      </div>
    </div>
  );
}

export default function PlaygroundStage() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [voiceId, setVoiceId] = useState(VOICES[0].id);
  const [busy, setBusy] = useState(false);
  const [takes, setTakes] = useState<Take[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);

  const voice = VOICES.find((v) => v.id === voiceId)!;
  const estSec = Math.max(1.5, Math.round(text.trim().length * 0.055 * 10) / 10);

  async function generate() {
    if (!text.trim() || busy) return;
    setBusy(true);
    const take = await fakeGenerate(text, voice);
    setTakes((t) => [take, ...t]);
    setBusy(false);
  }

  return (
    <div className="pb-24">
      <Eyebrow>free playground · stage</Eyebrow>

      <div className="mt-8 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        {/* stage */}
        <div className="glass-panel flex flex-col items-center rounded-3xl px-8 py-10">
          <Performer voice={voice} active={busy || playing !== null} />
          <div className="mt-8 flex flex-wrap justify-center gap-2">
            {VOICES.map((v) => (
              <button
                key={v.id}
                onClick={() => setVoiceId(v.id)}
                title={v.name}
                className={`h-9 w-9 rounded-full ring-2 transition ${v.id === voiceId ? "ring-white" : "ring-transparent hover:ring-white/40"}`}
                style={{ background: `radial-gradient(circle at 30% 30%, hsl(${v.hue} 90% 68%), hsl(${v.hue} 80% 42%))` }}
              />
            ))}
          </div>
        </div>

        {/* script */}
        <div className="glass-panel flex flex-col rounded-3xl p-7">
          <div className="font-jetbrains text-[11px] uppercase tracking-widest text-white/40">the script</div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder="Write the line to perform…"
            className="font-instrument mt-3 flex-1 resize-none bg-transparent text-2xl italic leading-snug text-white/90 placeholder:text-white/25 focus:outline-none"
          />
          <div className="mt-4 flex items-center justify-between border-t border-white/8 pt-4">
            <span className="font-jetbrains text-[11px] text-white/45">~{estSec}s · 24kHz wav</span>
            <Button onClick={generate} disabled={busy || !text.trim()}>
              {busy ? "Recording…" : "Perform take ●"}
            </Button>
          </div>
        </div>
      </div>

      {/* session */}
      <div className="mt-10">
        <div className="font-jetbrains mb-4 text-[11px] uppercase tracking-widest text-white/40">this session</div>

        {takes.length === 0 && !busy && (
          <div className="rounded-3xl border border-dashed border-white/10 px-6 py-12 text-center text-sm text-white/40">
            Your takes will appear here as you perform them.
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <AnimatePresence initial={false}>
            {takes.map((t) => {
              const v = VOICES.find((x) => x.id === t.voiceId)!;
              return (
                <motion.div
                  key={t.id}
                  layout
                  initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.45, ease: EASE }}
                  className="glass-panel rounded-2xl p-5"
                >
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setPlaying((p) => (p === t.id ? null : t.id))}
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-slate-950"
                      style={{ background: `hsl(${v.hue} 90% 66%)` }}
                    >
                      {playing === t.id ? "⏸" : "▶"}
                    </button>
                    <GlowWave seed={t.seed} hue={v.hue} playing={playing === t.id} className="h-10 flex-1" />
                  </div>
                  <p className="font-instrument mt-3 line-clamp-2 text-base italic text-white/80">“{t.text}”</p>
                  <div className="font-jetbrains mt-3 flex items-center gap-4 text-[11px] text-white/45">
                    <span className="text-white/70">{t.voiceName}</span>
                    <span>{t.seconds}s</span>
                    <span className="text-cyan-300">{t.rtf}× rt</span>
                    <span className="ml-auto cursor-pointer text-white/80 hover:text-white">↓ download</span>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
