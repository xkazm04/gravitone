"use client";

// WHEEL — spatial metaphor. The Character sits at the centre; its emotion Voices
// orbit as a dial. Filled slots glow in their hue and play on click; empty slots
// are ghosted drop-targets you record into. Reads as an instrument face.

import { motion } from "framer-motion";
import { EASE } from "@/components/ui/tokens";
import { useVoicePreview } from "@/app/voices/_variants/data";
import { pickAudio, type Slot } from "./useCharacterVoices";

const R = 148; // orbit radius (px)

export default function EmotionWheel({
  name, slots, coverage, total, busySlot, addVoice, removeVoice,
}: {
  name: string; slots: Slot[]; coverage: number; total: number; busySlot: string | null;
  addVoice: (emotion: string, f: File) => void; removeVoice: (id: string) => void;
}) {
  const { preview, playingId, busyId } = useVoicePreview();

  return (
    <div className="flex flex-col items-center py-6">
      <div className="relative grid h-[420px] w-[420px] place-items-center">
        {/* orbit ring */}
        <svg className="pointer-events-none absolute inset-0" viewBox="0 0 420 420" aria-hidden>
          <circle cx="210" cy="210" r={R} fill="none" stroke="rgba(255,255,255,0.07)" />
          {slots.map((s, i) => {
            const a = (i / slots.length) * Math.PI * 2 - Math.PI / 2;
            return (
              <line key={s.emotion} x1="210" y1="210"
                x2={210 + Math.cos(a) * R} y2={210 + Math.sin(a) * R}
                stroke={s.voice ? `hsl(${s.hue} 80% 60% / 0.28)` : "rgba(255,255,255,0.05)"} />
            );
          })}
        </svg>

        {/* centre */}
        <div className="z-10 grid h-32 w-32 place-items-center rounded-full border border-white/10 bg-[#0b0e15]/90 text-center backdrop-blur">
          <div>
            <div className="font-instrument text-xl leading-tight text-white">{name}</div>
            <div className="font-jetbrains mt-1 text-[10px] uppercase tracking-widest text-cyan-300/80">
              {coverage}/{total}
            </div>
          </div>
        </div>

        {/* slots */}
        {slots.map((s, i) => {
          const a = (i / slots.length) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(a) * R;
          const y = Math.sin(a) * R;
          const filled = !!s.voice;
          const isPlaying = filled && playingId === s.voice!.voice_id;
          const isBusy = busySlot === s.emotion || (filled && busyId === s.voice!.voice_id);

          return (
            <motion.div
              key={s.emotion}
              initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.45, ease: EASE, delay: i * 0.04 }}
              className="absolute"
              style={{ transform: `translate(${x}px, ${y}px)` }}
            >
              <div className="flex w-24 flex-col items-center">
                <button
                  onClick={() => (filled ? preview(s.voice!.voice_id, `${name} ${s.emotion}`) : pickAudio((f) => addVoice(s.emotion, f)))}
                  disabled={isBusy}
                  title={filled ? `Play ${s.label}` : `Record ${s.label} — currently falls back to baseline`}
                  className={`grid h-14 w-14 place-items-center rounded-full transition disabled:opacity-60 ${
                    filled ? "text-slate-950 hover:brightness-110" : "border border-dashed border-white/20 text-white/40 hover:border-cyan-400/50 hover:text-cyan-300"
                  }`}
                  style={filled ? {
                    background: `radial-gradient(circle at 32% 30%, hsl(${s.hue} 90% 72%), hsl(${s.hue} 80% 48%))`,
                    boxShadow: isPlaying ? `0 0 0 3px hsl(${s.hue} 90% 65% / .35), 0 0 26px hsl(${s.hue} 90% 60% / .55)` : `0 0 16px hsl(${s.hue} 90% 60% / .28)`,
                  } : undefined}
                >
                  {isBusy ? "…" : filled ? (isPlaying ? "⏸" : "▶") : "+"}
                </button>

                <span className="font-jetbrains mt-2 text-[11px] text-white/70">{s.label}</span>
                {filled ? (
                  <button onClick={() => removeVoice(s.voice!.voice_id)}
                    className="font-jetbrains text-[10px] text-white/25 transition hover:text-rose-300">
                    {s.voice!.sample_seconds ?? "?"}s · remove
                  </button>
                ) : (
                  <span className="font-jetbrains text-[10px] text-white/25">→ baseline</span>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>

      <p className="font-jetbrains mt-4 text-[11px] text-white/35">
        Click a lit slot to hear it · click a ghost slot to record that emotion
      </p>
    </div>
  );
}
