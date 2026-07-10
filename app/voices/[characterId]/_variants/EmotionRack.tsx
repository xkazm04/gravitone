"use client";

// RACK — operations metaphor, the sibling of the Character table. One dense row
// per emotion slot: status, sample, voice id, added, actions. Space-efficient and
// practical; every slot is visible at once with no scrolling or spatial hunting.

import { useVoicePreview } from "@/app/voices/_variants/data";
import { relTime } from "@/app/voices/_variants/data";
import EmotionArt from "@/components/ui/EmotionArt";
import { pickAudio, type Slot } from "./useCharacterVoices";

export default function EmotionRack({
  name, slots, coverage, total, busySlot, addVoice, removeVoice, onRecord,
}: {
  name: string; slots: Slot[]; coverage: number; total: number; busySlot: string | null;
  addVoice: (emotion: string, f: File) => void; removeVoice: (id: string) => void;
  onRecord: (emotion: string) => void; // open the guided capture session
}) {
  const { preview, playingId, busyId } = useVoicePreview();
  const missing = total - coverage;

  return (
    <div className="py-4">
      <div className="font-jetbrains mb-3 flex items-center justify-between text-[11px] uppercase tracking-widest text-white/60">
        <span>emotion rack</span>
        <span>
          {coverage}/{total} recorded{missing > 0 && <span className="ml-2 text-amber-300/70">· {missing} fall back to baseline</span>}
        </span>
      </div>

      <div className="glass-panel overflow-x-auto rounded-xl">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead className="border-b border-white/8">
            <tr className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
              <th className="w-10 px-2 py-2" />
              <th className="px-3 py-2 text-left font-normal">emotion</th>
              <th className="px-3 py-2 text-left font-normal">status</th>
              <th className="px-3 py-2 text-left font-normal">sample</th>
              <th className="px-3 py-2 text-left font-normal">voice id</th>
              <th className="px-3 py-2 text-left font-normal">added</th>
              <th className="w-40 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {slots.map((s) => {
              const filled = !!s.voice;
              const isPlaying = filled && playingId === s.voice!.voice_id;
              const isBusy = busySlot === s.emotion || (filled && busyId === s.voice!.voice_id);

              return (
                <tr key={s.emotion} className={`border-b border-white/5 transition hover:bg-white/[0.03] ${!filled ? "opacity-70" : ""}`}>
                  <td className="px-2 py-2">
                    <button
                      onClick={() => (filled ? preview(s.voice!.voice_id, `${name} ${s.emotion}`) : onRecord(s.emotion))}
                      disabled={isBusy}
                      aria-label={filled ? `Play ${s.label}` : `Record ${s.label}`}
                      className={`grid h-7 w-7 place-items-center rounded-full text-[11px] transition disabled:opacity-50 ${
                        filled ? "text-slate-950 hover:brightness-110" : "border border-dashed border-white/20 text-white/65 hover:border-cyan-400/50 hover:text-cyan-300"
                      }`}
                      style={filled ? { background: `hsl(${s.hue} 85% 64%)` } : undefined}
                    >
                      {isBusy ? "…" : filled ? (isPlaying ? "⏸" : "▶") : "+"}
                    </button>
                  </td>

                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-white/8 bg-black/40">
                        <EmotionArt emotion={s.emotion} size={34} dim={!filled} />
                      </span>
                      <span className="text-sm font-medium text-white">{s.label}</span>
                    </div>
                  </td>

                  <td className="px-3 py-2">
                    {filled ? (
                      <span className="font-jetbrains rounded bg-cyan-400/10 px-1.5 py-0.5 text-[11px] text-cyan-300">recorded</span>
                    ) : (
                      <span className="font-jetbrains rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-white/65">→ baseline</span>
                    )}
                  </td>

                  <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{filled ? `${s.voice!.sample_seconds ?? "?"}s` : "—"}</td>
                  <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{filled ? s.voice!.voice_id : "—"}</td>
                  <td className="font-jetbrains px-3 py-2 text-[12px] text-white/65">{filled ? relTime(s.voice!.created) : "—"}</td>

                  <td className="px-3 py-2 text-right">
                    {filled ? (
                      <>
                        <button onClick={() => pickAudio((f) => addVoice(s.emotion, f))} disabled
                          title="Remove first, then re-record this slot"
                          className="font-jetbrains text-[11px] text-white/15">replace</button>
                        <button onClick={() => removeVoice(s.voice!.voice_id)}
                          className="font-jetbrains ml-3 text-[11px] text-white/55 transition hover:text-rose-300">remove</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => onRecord(s.emotion)} disabled={isBusy}
                          className="font-jetbrains text-[11px] text-cyan-300/80 transition hover:text-cyan-200 disabled:opacity-50">
                          {isBusy ? "cloning…" : "● record this"}
                        </button>
                        <button onClick={() => pickAudio((f) => addVoice(s.emotion, f))} disabled={isBusy}
                          className="font-jetbrains ml-3 text-[11px] text-white/45 transition hover:text-white/80 disabled:opacity-50">
                          upload
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
