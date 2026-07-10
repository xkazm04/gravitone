"use client";

// CONSOLE — instrument/terminal metaphor. The screen is a precise audio console:
// mono labels, hairline dividers, a dense compose bay, and a takes log. The user
// feels like an operator. Different from Stage (performer-first, cinematic).

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import { EASE } from "@/components/ui/tokens";
import { VOICES, fakeGenerate, waveHeights, DEFAULT_TEXT, type Take } from "./shared";

function Bars({ seed, playing, className = "" }: { seed: number; playing?: boolean; className?: string }) {
  return (
    <div className={`flex items-end gap-[2px] ${className}`} aria-hidden>
      {waveHeights(seed, 44).map((h, i) => (
        <span
          key={i}
          className={`w-[2px] rounded-full bg-cyan-300/70 ${playing ? "eq-bar" : ""}`}
          style={{ height: `${Math.round(h * 100)}%`, animationDelay: `${(i % 7) * 0.08}s` }}
        />
      ))}
    </div>
  );
}

export default function PlaygroundConsole() {
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
      <Eyebrow>free playground · console</Eyebrow>
      <h1 className="font-instrument mt-4 text-4xl text-white">Compose a take.</h1>

      {/* compose bay */}
      <div className="glass-panel mt-8 rounded-2xl">
        <div className="font-jetbrains flex items-center justify-between border-b border-white/8 px-5 py-2.5 text-[11px] uppercase tracking-widest text-white/40">
          <span>compose</span>
          <span>{text.trim().length} chars · ~{estSec}s audio</span>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generate(); }}
          rows={4}
          placeholder="Type something for the voice to say…"
          className="font-hanken w-full resize-none bg-transparent px-5 py-4 text-base leading-relaxed text-white placeholder:text-white/30 focus:outline-none"
        />

        {/* voice rail */}
        <div className="border-t border-white/8 px-5 py-4">
          <div className="font-jetbrains mb-2 text-[11px] uppercase tracking-widest text-white/40">voice</div>
          <div className="flex flex-wrap gap-2">
            {VOICES.map((v) => {
              const on = v.id === voiceId;
              return (
                <button
                  key={v.id}
                  onClick={() => setVoiceId(v.id)}
                  className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition ${
                    on ? "border-cyan-400/40 bg-cyan-400/10" : "border-white/10 hover:border-white/25"
                  }`}
                >
                  <span className="h-6 w-6 rounded-full" style={{ background: `radial-gradient(circle at 30% 30%, hsl(${v.hue} 90% 70%), hsl(${v.hue} 80% 45%))` }} />
                  <span>
                    <span className="flex items-center gap-1.5 text-sm text-white">
                      {v.name}
                      <span className="font-jetbrains text-[10px] text-white/45">{v.lang}</span>
                    </span>
                    <span className="font-jetbrains text-[10px] text-white/40">
                      {v.source === "cloned" ? `cloned · ${v.sample}` : "built-in"} · {v.rtf}× rt
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-white/8 px-5 py-3">
          <span className="font-jetbrains text-[11px] text-white/40">⌘↵ to generate · exports 24kHz wav</span>
          <Button onClick={generate} disabled={busy || !text.trim()}>
            {busy ? "Rendering…" : "Generate ▶"}
          </Button>
        </div>
      </div>

      {/* takes log */}
      <div className="mt-8">
        <div className="font-jetbrains mb-3 flex items-center justify-between text-[11px] uppercase tracking-widest text-white/40">
          <span>takes</span><span>{takes.length}</span>
        </div>

        {takes.length === 0 && !busy && (
          <div className="rounded-2xl border border-dashed border-white/10 px-5 py-10 text-center text-sm text-white/40">
            No takes yet — compose above and hit Generate.
          </div>
        )}

        <AnimatePresence initial={false}>
          {busy && (
            <motion.div
              initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="glass-panel mb-2 flex items-center gap-4 rounded-xl px-5 py-4"
            >
              <span className="font-jetbrains text-[11px] text-cyan-300">rendering</span>
              <Bars seed={7} playing className="h-8 flex-1" />
            </motion.div>
          )}
          {takes.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: EASE }}
              className="glass-panel mb-2 rounded-xl px-5 py-4"
            >
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setPlaying((p) => (p === t.id ? null : t.id))}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-cyan-300 text-slate-950"
                >
                  {playing === t.id ? "⏸" : "▶"}
                </button>
                <Bars seed={t.seed} playing={playing === t.id} className="h-9 flex-1" />
                <div className="font-jetbrains hidden shrink-0 items-center gap-4 text-[11px] text-white/50 sm:flex">
                  <span className="text-white/80">{t.voiceName}</span>
                  <span>{t.seconds}s</span>
                  <span className="text-cyan-300">{t.rtf}× rt</span>
                  <span>{t.kb} kb</span>
                </div>
                <button className="font-jetbrains shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/80 hover:bg-white/5">
                  ↓ wav
                </button>
              </div>
              <p className="mt-2 line-clamp-1 pl-13 text-sm text-white/45">{t.text}</p>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
