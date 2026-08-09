"use client";

import { relTime, signalOf, derivedDonorLabel, type Slot, type Voice } from "@/app/voices/_data/characters";
import EmotionIcon from "@/components/ui/EmotionIcon";
import SignalChip from "@/app/voices/_variants/SignalChip";
import EmotionSlotActions from "./EmotionSlotActions";

/** One dense rack row: status, sample, voice id, added, actions for one slot. */
export default function EmotionSlotRow({
  slot: s, name, shadows, busySlot, playingId, busyId, failedId, failedReason,
  removingVoiceId, failedDerive, canDerive, pickerOpen, preview, onRecord, addVoice,
  openPicker, confirmRemove, dropSlot,
}: {
  slot: Slot;
  name: string;
  /** The extra voices this slot carries — this row only reports that they exist. */
  shadows: Voice[];
  busySlot: string | null;
  playingId: string | null;
  busyId: string | null;
  failedId: string | null;
  failedReason: string | null;
  removingVoiceId: string | null;
  /** The service's refusal for THIS slot's last derive attempt, or null. */
  failedDerive: string | null;
  canDerive: boolean;
  pickerOpen: boolean;
  preview: (voiceId: string, label: string, line?: string) => void;
  onRecord: (emotion: string) => void;
  addVoice: (emotion: string, f: File) => void;
  openPicker: (emotion: string) => void;
  confirmRemove: (voiceId: string, label: string, shadowed?: boolean) => void;
  dropSlot: (emotion: string) => Promise<void>;
}) {
  const filled = !!s.voice;
  const isPlaying = filled && playingId === s.voice!.voice_id;
  const isBusy = busySlot === s.emotion || (filled && busyId === s.voice!.voice_id);
  const previewFailed = filled && failedId === s.voice!.voice_id;
  // The measured fact about the voice that speaks this slot, or null
  // when nothing was measured (old rows, built-ins, unreadable audio).
  const signal = filled ? signalOf(s.voice!.fidelity) : null;
  // Non-null ONLY for a computed slot, and it names who it came
  // from. Everything below branches on this rather than on a
  // string comparison, so there is one place that decides what
  // "derived" looks like.
  const derivedFrom = derivedDonorLabel(s.voice);

  return (
    <tr className={`border-b border-white/5 transition hover:bg-white/[0.03] ${!filled ? "opacity-70" : ""}`}>
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
            <EmotionIcon emotion={s.emotion} size={20} dim={!filled} />
          </span>
          <span className="text-sm font-medium text-white">{s.label}</span>
          {filled && (
            s.voice!.consent ? (
              <span title="Consent receipt on file for this voice"
                aria-label="consent receipt on file"
                className="text-[13px] leading-none text-emerald-300/90">🛡</span>
            ) : (
              <span title="No receipt (pre-consent voice)"
                aria-label="no consent receipt"
                className="text-[13px] leading-none text-white/25">🛡</span>
            )
          )}
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
          <span className="flex flex-wrap items-center gap-2">
            {derivedFrom ? (
              <>
                {/* NEVER the "recorded" chip. A derived slot speaks,
                    but nobody performed it, and its own accent
                    (violet — the same one the custom-slot badge uses
                    for "this is a studio construct") keeps the two
                    unmistakable at a glance. */}
                <span
                  title={`This slot was COMPUTED from ${name}'s baseline plus the emotion direction taken from ${derivedFrom}. Nobody recorded it. Promote it to a recording whenever you can.`}
                  className="font-jetbrains rounded border border-violet-400/30 bg-violet-400/10 px-1.5 py-0.5 text-[11px] text-violet-200">
                  derived · from {derivedFrom}
                </span>
                {s.demand > 0 && (
                  // The demand counter stays ALIVE for a derived
                  // slot: the appetite was for this speaker actually
                  // performing it, and computing a stand-in did not
                  // answer that.
                  <span
                    className="font-jetbrains rounded bg-amber-400/10 px-1.5 py-0.5 text-[11px] text-amber-300"
                    title={`API callers asked for ${s.label} ${s.demand}x. They are being served the derived take — a real recording would still be better.`}
                  >
                    still requested {s.demand}x
                  </span>
                )}
              </>
            ) : (
              <span className="font-jetbrains rounded bg-cyan-400/10 px-1.5 py-0.5 text-[11px] text-cyan-300">recorded</span>
            )}
            {/* What the studio HEARD in this take. Absent for every
                voice cloned before the ledger existed, and the chip
                renders nothing at all for that. */}
            <SignalChip signal={signal} note={`${s.label} take`} />
            {shadows.length > 0 && (
              <span
                title="Two voices occupy this slot — this is the one the engine speaks with"
                className="font-jetbrains rounded bg-emerald-400/10 px-1.5 py-0.5 text-[11px] text-emerald-300">
                speaks this slot
              </span>
            )}
            {previewFailed && (
              // The reason, not just the fact: an unreachable
              // backend, a 429 and a blocked autoplay are three
              // different things for the user to do next.
              <span title={failedReason ?? "The preview could not be synthesized — try again."}
                className="font-jetbrains rounded bg-rose-400/10 px-1.5 py-0.5 text-[11px] text-rose-300">
                {`preview failed${failedReason ? ` — ${failedReason}` : ""}`}
              </span>
            )}
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            {s.demand > 0 ? (
              <span
                className="font-jetbrains rounded bg-amber-400/10 px-1.5 py-0.5 text-[11px] text-amber-300"
                title={`API callers requested ${s.label} ${s.demand}× and got baseline — record it to meet the demand`}
              >
                requested {s.demand}× → baseline
              </span>
            ) : (
              <span className="font-jetbrains rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-white/65">→ baseline</span>
            )}
            {failedDerive && (
              // The service's refusal, in full, against the slot it
              // refused. Amber (advisory) rather than rose: nothing
              // broke, and "no basis has been built yet" is a step
              // the user can take, not an error they suffered.
              <span
                role="status"
                title={failedDerive}
                className="font-jetbrains max-w-md rounded bg-amber-400/10 px-1.5 py-0.5 text-[11px] leading-relaxed text-amber-300">
                can’t derive yet — {failedDerive}
              </span>
            )}
          </span>
        )}
      </td>

      <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{filled ? `${s.voice!.sample_seconds ?? "?"}s` : "—"}</td>
      <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{filled ? s.voice!.voice_id : "—"}</td>
      <td className="font-jetbrains px-3 py-2 text-[12px] text-white/65">{filled ? relTime(s.voice!.created) : "—"}</td>

      <EmotionSlotActions
        slot={s} name={name} filled={filled} isBusy={isBusy}
        derivedFrom={derivedFrom} signal={signal} removingVoiceId={removingVoiceId}
        canDerive={canDerive} pickerOpen={pickerOpen} onRecord={onRecord}
        addVoice={addVoice} openPicker={openPicker} confirmRemove={confirmRemove}
        dropSlot={dropSlot}
      />
    </tr>
  );
}
