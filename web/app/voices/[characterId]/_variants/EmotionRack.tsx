"use client";

// RACK — operations metaphor, the sibling of the Character table. One dense row
// per emotion slot: status, sample, voice id, added, actions. Space-efficient and
// practical; every slot is visible at once with no scrolling or spatial hunting.

import { useState } from "react";
import { useVoicePreview } from "@/app/voices/_variants/data";
import { relTime } from "@/app/voices/_variants/data";
import EmotionArt from "@/components/ui/EmotionArt";
import { pickAudio, type Slot } from "./useCharacterVoices";

export default function EmotionRack({
  name, slots, coverage, total, busySlot, addVoice, removeVoice, onRecord,
  addCustomEmotion, removeCustomEmotion,
}: {
  name: string; slots: Slot[]; coverage: number; total: number; busySlot: string | null;
  addVoice: (emotion: string, f: File) => void; removeVoice: (id: string) => void;
  onRecord: (emotion: string) => void; // open the guided capture session
  addCustomEmotion: (name: string) => Promise<void>;
  removeCustomEmotion: (emotion: string) => Promise<void>;
}) {
  const { preview, playingId, busyId } = useVoicePreview();
  const [custom, setCustom] = useState("");
  const [minting, setMinting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const missing = total - coverage;

  async function mint() {
    const n = custom.trim();
    if (!n || minting) return;
    setMinting(true); setErr(null);
    try {
      await addCustomEmotion(n);
      setCustom("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not add the slot");
    } finally { setMinting(false); }
  }

  async function dropSlot(emotion: string) {
    setErr(null);
    try { await removeCustomEmotion(emotion); }
    catch (e) { setErr(e instanceof Error ? e.message : "could not remove the slot"); }
  }

  return (
    <div className="py-4">
      <div className="font-jetbrains mb-3 flex items-center justify-between text-[11px] uppercase tracking-widest text-white/60">
        <span>emotion rack</span>
        <span>
          {coverage}/{total} recorded{missing > 0 && <span className="ml-2 text-amber-300/70">· {missing} fall back to baseline</span>}
        </span>
      </div>

      {err && (
        <p className="font-jetbrains mb-3 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200/90">{err}</p>
      )}

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
                      {s.custom && (
                        <span title="Custom emotion — glyph generated from the name"
                          className="font-jetbrains rounded-full border border-violet-400/30 bg-violet-400/10 px-1.5 py-0.5 text-[10px] text-violet-200">
                          custom
                        </span>
                      )}
                    </div>
                  </td>

                  <td className="px-3 py-2">
                    {filled ? (
                      <span className="font-jetbrains rounded bg-cyan-400/10 px-1.5 py-0.5 text-[11px] text-cyan-300">recorded</span>
                    ) : s.demand > 0 ? (
                      <span
                        className="font-jetbrains rounded bg-amber-400/10 px-1.5 py-0.5 text-[11px] text-amber-300"
                        title={`API callers requested ${s.label} ${s.demand}× and got baseline — record it to meet the demand`}
                      >
                        requested {s.demand}× → baseline
                      </span>
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
                        {s.custom && (
                          <button onClick={() => void dropSlot(s.emotion)} disabled={isBusy}
                            title="Remove this custom slot"
                            className="font-jetbrains ml-3 text-[11px] text-white/35 transition hover:text-rose-300 disabled:opacity-50">
                            drop
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* custom emotion palette — the scale is a platform primitive, not a constant */}
      <div className="glass-panel mt-4 rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
            extend the palette
          </span>
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void mint()}
            placeholder="sarcastic, battle cry, asmr…"
            maxLength={24}
            className="font-hanken w-56 rounded-lg border border-white/12 bg-white/[0.03] px-3 py-1.5 text-sm text-white placeholder:text-white/40 focus:border-violet-400/40 focus:outline-none"
          />
          <button
            onClick={() => void mint()}
            disabled={!custom.trim() || minting}
            className="font-jetbrains cursor-pointer rounded-full border border-violet-400/30 bg-violet-400/10 px-3 py-1.5 text-[12px] text-violet-200 transition hover:bg-violet-400/20 disabled:opacity-40"
          >
            {minting ? "adding…" : "+ custom emotion"}
          </button>
        </div>
        <p className="font-jetbrains mt-2 text-[11px] leading-relaxed text-white/45">
          A custom slot is addressable immediately —{" "}
          <span className="text-violet-200">{name.toLowerCase().replace(/\s+/g, "-")}:{custom.trim().toLowerCase().replace(/[\s-]+/g, "_") || "sarcastic"}</span>{" "}
          in the API and <span className="text-violet-200">[{custom.trim().toLowerCase().replace(/[\s-]+/g, "_") || "sarcastic"}]</span> in metatags — and
          falls back to baseline until you record it. Its glyph is generated from the name.
        </p>
      </div>
    </div>
  );
}
