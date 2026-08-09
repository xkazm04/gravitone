"use client";

import { relTime, type Slot, type Voice } from "@/app/voices/_data/characters";
import EmotionIcon from "@/components/ui/EmotionIcon";

/** One of the extra voices registered on a slot that another voice speaks. */
export default function EmotionShadowRow({
  voice: v, slot: s, name, preview, playingId, busyId, failedId, failedReason,
  removingVoiceId, onRemove,
}: {
  voice: Voice;
  slot: Slot;
  name: string;
  preview: (voiceId: string, label: string, line?: string) => void;
  playingId: string | null;
  busyId: string | null;
  failedId: string | null;
  failedReason: string | null;
  removingVoiceId: string | null;
  onRemove: () => void;
}) {
  const vBusy = busyId === v.voice_id;
  return (
    <tr className="border-b border-white/5 bg-amber-400/[0.03] transition hover:bg-white/[0.03]">
      <td className="px-2 py-2">
        <button
          onClick={() => preview(v.voice_id, `${name} ${s.emotion}`)}
          disabled={vBusy}
          aria-label={`Play the shadowed ${s.label} voice`}
          className="grid h-7 w-7 place-items-center rounded-full border border-amber-300/40 text-[11px] text-amber-200 transition hover:bg-amber-400/10 disabled:opacity-50"
        >
          {vBusy ? "…" : playingId === v.voice_id ? "⏸" : "▶"}
        </button>
      </td>

      <td className="px-3 py-2">
        <div className="flex items-center gap-2.5 pl-4">
          <span className="font-jetbrains text-[12px] text-white/40">↳</span>
          <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-lg border border-white/8 bg-black/40">
            <EmotionIcon emotion={s.emotion} size={18} dim />
          </span>
          <span className="text-sm text-white/70">{s.label}</span>
          {v.consent ? (
            <span title="Consent receipt on file for this voice"
              aria-label="consent receipt on file"
              className="text-[13px] leading-none text-emerald-300/90">🛡</span>
          ) : (
            <span title="No receipt (pre-consent voice)"
              aria-label="no consent receipt"
              className="text-[13px] leading-none text-white/25">🛡</span>
          )}
        </div>
      </td>

      <td className="px-3 py-2">
        <span className="flex items-center gap-2">
          <span
            title={`This slot already had a voice when this one was registered, so ${s.label} is spoken by ${s.voice!.voice_id}. Remove one of them to resolve the duplicate.`}
            className="font-jetbrains rounded bg-amber-400/10 px-1.5 py-0.5 text-[11px] text-amber-300">
            shadowed · never spoken
          </span>
          {failedId === v.voice_id && (
            <span title={failedReason ?? "The preview could not be synthesized — try again."}
              className="font-jetbrains rounded bg-rose-400/10 px-1.5 py-0.5 text-[11px] text-rose-300">
              {`preview failed${failedReason ? ` — ${failedReason}` : ""}`}
            </span>
          )}
        </span>
      </td>

      <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{v.sample_seconds ?? "?"}s</td>
      <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{v.voice_id}</td>
      <td className="font-jetbrains px-3 py-2 text-[12px] text-white/65">{relTime(v.created)}</td>

      <td className="px-3 py-2 text-right">
        <button onClick={onRemove}
          disabled={removingVoiceId === v.voice_id}
          aria-label={`Remove the shadowed ${s.label} voice`}
          title="Delete this voice — the slot keeps the voice that speaks"
          className="font-jetbrains text-[11px] text-white/55 transition hover:text-rose-300 disabled:opacity-40">
          {removingVoiceId === v.voice_id ? "removing…" : "remove"}
        </button>
      </td>
    </tr>
  );
}
