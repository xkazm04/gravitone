"use client";

/** The ledger's own visual language while a drill-down arrives: the same glass
 *  panel it will become, saying what it is waiting for. */
export default function VoiceNewPanelLoading({ label }: { label: string }) {
  return (
    <div className="glass-panel rounded-2xl px-5 py-4">
      <span className="font-jetbrains text-[11px] text-white/40">{label}</span>
    </div>
  );
}
