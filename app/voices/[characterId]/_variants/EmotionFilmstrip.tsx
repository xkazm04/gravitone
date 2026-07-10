"use client";

// FILMSTRIP — sequence metaphor. The emotion scale reads left-to-right as frames
// on a reel, so adjacent emotions are easy to compare. Filled frames carry a
// live meter while playing; empty frames are dashed "shoot this one" slates.

import { motion } from "framer-motion";
import { EASE } from "@/components/ui/tokens";
import { useVoicePreview } from "@/app/voices/_variants/data";
import { pickAudio, type Slot } from "./useCharacterVoices";

function Meter({ hue, active }: { hue: number; active: boolean }) {
  return (
    <div className="flex h-10 items-end justify-center gap-[3px]" aria-hidden>
      {[0.35, 0.7, 0.45, 0.95, 0.6, 0.85, 0.4].map((h, i) => (
        <span
          key={i}
          className={`w-[3px] rounded-full ${active ? "eq-bar" : ""}`}
          style={{
            height: active ? "100%" : `${h * 100}%`,
            background: `hsl(${hue} 85% 62%)`,
            opacity: active ? 1 : 0.45,
            animationDelay: `${i * 0.08}s`,
          }}
        />
      ))}
    </div>
  );
}

export default function EmotionFilmstrip({
  name, slots, coverage, total, busySlot, addVoice, removeVoice,
}: {
  name: string; slots: Slot[]; coverage: number; total: number; busySlot: string | null;
  addVoice: (emotion: string, f: File) => void; removeVoice: (id: string) => void;
}) {
  const { preview, playingId, busyId } = useVoicePreview();

  return (
    <div className="py-4">
      <div className="font-jetbrains mb-3 flex items-center justify-between text-[11px] uppercase tracking-widest text-white/40">
        <span>emotion reel</span>
        <span>{coverage}/{total} recorded</span>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-4">
        {slots.map((s, i) => {
          const filled = !!s.voice;
          const isPlaying = filled && playingId === s.voice!.voice_id;
          const isBusy = busySlot === s.emotion || (filled && busyId === s.voice!.voice_id);

          return (
            <motion.div
              key={s.emotion}
              initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: EASE, delay: i * 0.035 }}
              className={`relative w-[168px] shrink-0 rounded-xl border p-4 transition ${
                filled ? "glass-panel" : "border-dashed border-white/12 bg-transparent"
              }`}
              style={filled && isPlaying ? { borderColor: `hsl(${s.hue} 80% 55% / .5)` } : undefined}
            >
              {/* frame number + hue band */}
              <div className="flex items-center justify-between">
                <span className="font-jetbrains text-[10px] text-white/30">{String(i + 1).padStart(2, "0")}</span>
                <span className="h-1.5 w-10 rounded-full" style={{ background: filled ? `hsl(${s.hue} 85% 60%)` : "rgba(255,255,255,0.10)" }} />
              </div>

              <div className="mt-3 text-base font-medium text-white">{s.label}</div>

              <div className="mt-3">
                {filled ? <Meter hue={s.hue} active={isPlaying} /> : (
                  <div className="grid h-10 place-items-center font-jetbrains text-[10px] text-white/25">falls back → baseline</div>
                )}
              </div>

              <div className="mt-4">
                {filled ? (
                  <>
                    <button onClick={() => preview(s.voice!.voice_id, `${name} ${s.emotion}`)} disabled={isBusy}
                      className="w-full rounded-full bg-cyan-300 px-3 py-1.5 text-[12px] font-semibold text-slate-950 transition hover:brightness-110 disabled:opacity-50">
                      {isBusy ? "…" : isPlaying ? "⏸ stop" : "▶ play"}
                    </button>
                    <div className="font-jetbrains mt-2 flex items-center justify-between text-[10px] text-white/35">
                      <span>{s.voice!.sample_seconds ?? "?"}s sample</span>
                      <button onClick={() => removeVoice(s.voice!.voice_id)} className="transition hover:text-rose-300">remove</button>
                    </div>
                  </>
                ) : (
                  <button onClick={() => pickAudio((f) => addVoice(s.emotion, f))} disabled={isBusy}
                    className="font-jetbrains w-full rounded-full border border-white/15 px-3 py-1.5 text-[12px] text-white/70 transition hover:border-cyan-400/40 hover:text-cyan-300 disabled:opacity-50">
                    {isBusy ? "cloning…" : "+ record"}
                  </button>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
