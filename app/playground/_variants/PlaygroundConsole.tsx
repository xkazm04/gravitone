"use client";

// CONSOLE — the winning direction. Operator/terminal metaphor: a precise audio
// console with a compose bay, a voice rail carrying real stats, and a takes log
// with true transport (play / pause / stop) + WAV export.

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import { EASE } from "@/components/ui/tokens";
import { VOICES, DEFAULT_TEXT, type Take } from "./shared";
import { synthesize } from "./engine";
import { useAudioPlayer } from "./useAudioPlayer";

/** Static waveform; playback progress is expressed as colour, not motion. */
function Bars({
  peaks,
  progress = 0,
  active = false,
  className = "",
}: {
  peaks: number[];
  progress?: number;
  active?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex items-end gap-[2px] ${className}`} aria-hidden>
      {peaks.map((h, i) => {
        const played = active && i / peaks.length <= progress;
        return (
          <span
            key={i}
            className={`w-[2px] shrink-0 rounded-full transition-colors duration-75 ${
              played ? "bg-cyan-300" : "bg-white/25"
            }`}
            style={{ height: `${Math.max(6, Math.round(h * 100))}%` }}
          />
        );
      })}
    </div>
  );
}

export default function PlaygroundConsole() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [voiceId, setVoiceId] = useState(VOICES[0].id);
  const [busy, setBusy] = useState(false);
  const [takes, setTakes] = useState<Take[]>([]);
  const seq = useRef(0);

  const { playingId, paused, progress, toggle, stop } = useAudioPlayer();

  const voice = VOICES.find((v) => v.id === voiceId)!;
  const estSec = Math.max(1.5, Math.round(text.trim().length * 0.055 * 10) / 10);
  const usingFallback = takes.some((t) => t.mode === "browser");

  async function generate() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const r = await synthesize(text, voice);
      seq.current += 1;
      const take: Take = {
        id: `take-${seq.current}`,
        text: text.trim(),
        voiceId: voice.id,
        voiceName: voice.name,
        hue: voice.hue,
        mode: r.mode,
        url: r.url,
        peaks: r.peaks,
        seconds: r.seconds,
        kb: r.kb,
        rtf: r.rtf,
      };
      setTakes((t) => [take, ...t]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pb-24">
      <Eyebrow>free playground</Eyebrow>
      <h1 className="font-instrument mt-4 text-4xl text-white">Compose a take.</h1>

      {usingFallback && (
        <p className="font-jetbrains mt-4 rounded-lg border border-amber-400/25 bg-amber-400/5 px-4 py-2 text-[11px] text-amber-200/90">
          Gravitone backend unreachable — speaking with your browser voice. Start the service or set{" "}
          <span className="text-amber-100">GRAVITONE_URL</span> to export real WAVs.
        </p>
      )}

      {/* compose bay */}
      <div className="glass-panel mt-8 rounded-2xl">
        <div className="font-jetbrains flex items-center justify-between border-b border-white/8 px-5 py-2.5 text-[11px] uppercase tracking-widest text-white/40">
          <span>compose</span>
          <span>
            {text.trim().length} chars · ~{estSec}s audio
          </span>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generate();
          }}
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
                  aria-pressed={on}
                  className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition ${
                    on ? "border-cyan-400/40 bg-cyan-400/10" : "border-white/10 hover:border-white/25"
                  }`}
                >
                  <span
                    className="h-6 w-6 rounded-full"
                    style={{ background: `radial-gradient(circle at 30% 30%, hsl(${v.hue} 90% 70%), hsl(${v.hue} 80% 45%))` }}
                  />
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
          <span>takes</span>
          <span>{takes.length}</span>
        </div>

        {takes.length === 0 && !busy && (
          <div className="rounded-2xl border border-dashed border-white/10 px-5 py-10 text-center text-sm text-white/40">
            No takes yet — compose above and hit Generate.
          </div>
        )}

        <AnimatePresence initial={false}>
          {busy && (
            <motion.div
              key="rendering"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="glass-panel mb-2 flex items-center gap-4 rounded-xl px-5 py-4"
            >
              <span className="font-jetbrains shrink-0 text-[11px] text-cyan-300">rendering</span>
              <div className="flex h-8 flex-1 items-end gap-[2px]">
                {Array.from({ length: 44 }).map((_, i) => (
                  <span
                    key={i}
                    className="eq-bar w-[2px] rounded-full bg-cyan-300/60"
                    style={{ height: "100%", animationDelay: `${(i % 7) * 0.08}s` }}
                  />
                ))}
              </div>
            </motion.div>
          )}

          {takes.map((t) => {
            const isCurrent = playingId === t.id;
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: EASE }}
                className="glass-panel mb-2 rounded-xl px-5 py-4"
              >
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => toggle(t)}
                    aria-label={isCurrent && !paused ? "Pause" : "Play"}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-cyan-300 text-slate-950 transition hover:brightness-110"
                  >
                    {isCurrent && !paused ? "⏸" : "▶"}
                  </button>

                  <button
                    onClick={stop}
                    disabled={!isCurrent}
                    aria-label="Stop"
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/15 text-white/70 transition enabled:hover:bg-white/5 disabled:opacity-25"
                  >
                    ■
                  </button>

                  <Bars peaks={t.peaks} progress={isCurrent ? progress : 0} active={isCurrent} className="h-9 min-w-0 flex-1" />

                  <div className="font-jetbrains hidden shrink-0 items-center gap-4 text-[11px] text-white/50 sm:flex">
                    <span className="text-white/80">{t.voiceName}</span>
                    <span>{t.seconds}s</span>
                    <span className="text-cyan-300">{t.rtf}× rt</span>
                    {t.kb > 0 && <span>{t.kb} kb</span>}
                  </div>

                  {t.url ? (
                    <a
                      href={t.url}
                      download={`gravitone-${t.voiceId}-${t.id}.wav`}
                      className="font-jetbrains shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/80 transition hover:bg-white/5"
                    >
                      ↓ wav
                    </a>
                  ) : (
                    <span
                      title="Connect a Gravitone endpoint to export WAV"
                      className="font-jetbrains shrink-0 cursor-not-allowed rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-white/25"
                    >
                      ↓ wav
                    </span>
                  )}
                </div>

                <p className="mt-2 line-clamp-1 text-sm text-white/45">{t.text}</p>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
