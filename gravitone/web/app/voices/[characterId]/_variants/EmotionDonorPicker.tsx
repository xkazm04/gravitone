"use client";

import type { Slot } from "@/app/voices/_data/characters";
import type { DonorPool } from "./useEmotionRackDonors";

/** The in-place row an empty slot opens to choose what to compute itself from. */
export default function EmotionDonorPicker({
  slot: s, donors, derivingFrom, onDerive, onCancel,
}: {
  slot: Slot;
  donors: DonorPool;
  /** The donor whose derive is in flight ("_basis" for the shared basis), or null. */
  derivingFrom: string | null;
  onDerive: (donor: string | null) => void;
  onCancel: () => void;
}) {
  return (
    // The donor picker. Compact and in place — a modal for a
    // choice between four names would be a bigger interruption
    // than the action deserves, and the slot it belongs to has to
    // stay visible while you choose.
    <tr className="border-b border-white/5 bg-violet-400/[0.04]">
      <td />
      <td colSpan={6} className="px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/55">
            derive {s.label} from
          </span>
          <button
            onClick={() => onDerive(null)}
            disabled={derivingFrom !== null}
            title="The shared emotion basis: the average direction across every speaker in this install that has recorded this emotion. Refused unless that direction was measured to transfer between speakers."
            className="font-jetbrains rounded-full border border-violet-400/30 bg-violet-400/10 px-3 py-1 text-[11px] text-violet-200 transition hover:bg-violet-400/20 disabled:opacity-40">
            {derivingFrom === "_basis" ? "deriving…" : "shared basis"}
          </button>
          {(donors.donors ?? [])
            .filter((d) => d.emotions.includes(s.emotion))
            .map((d) => (
              <button
                key={d.characterId}
                onClick={() => onDerive(d.characterId)}
                disabled={derivingFrom !== null}
                title={`Take the ${s.label} direction from ${d.name}'s own recording of it.`}
                className="font-jetbrains rounded-full border border-white/12 bg-white/[0.03] px-3 py-1 text-[11px] text-white/75 transition hover:border-violet-400/30 hover:text-violet-100 disabled:opacity-40">
                {derivingFrom === d.characterId ? "deriving…" : d.name}
              </button>
            ))}
          {donors.loading && (
            <span className="font-jetbrains text-[11px] text-white/45">loading donors…</span>
          )}
          {donors.error && (
            <span className="font-jetbrains text-[11px] text-amber-300">
              donors unavailable — {donors.error}
            </span>
          )}
          {donors.donors !== null && !donors.loading &&
           !donors.donors.some((d) => d.emotions.includes(s.emotion)) && (
            // Absent, and said out loud: with no donor for THIS
            // emotion the shared basis is the only route, and
            // recording it is the only certain one.
            <span className="font-jetbrains text-[11px] text-white/45">
              no other character has recorded {s.label} yet
            </span>
          )}
          <button
            onClick={onCancel}
            className="font-jetbrains ml-auto text-[11px] text-white/45 transition hover:text-white/80">
            cancel
          </button>
        </div>
        <p className="font-jetbrains mt-2 text-[11px] leading-relaxed text-white/45">
          A derived slot is computed, not performed — it is badged{" "}
          <span className="text-violet-200">derived</span> everywhere,
          keeps asking to be recorded, and can be deleted or promoted at any time.
        </p>
      </td>
    </tr>
  );
}
