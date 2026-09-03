"use client";

import { pickAudio, type Signal, type Slot } from "@/app/voices/_data/characters";

/** The right-hand cell of a rack row: everything you can do about this slot. */
export default function EmotionSlotActions({
  slot: s, name, filled, isBusy, derivedFrom, signal, removingVoiceId, canDerive,
  pickerOpen, onRecord, addVoice, openPicker, confirmRemove, dropSlot,
}: {
  slot: Slot;
  name: string;
  filled: boolean;
  isBusy: boolean;
  /** Non-null only for a computed slot; it names who the direction came from. */
  derivedFrom: string | null;
  signal: Signal | null;
  removingVoiceId: string | null;
  /** Whether the page supplied a `deriveVoice` at all — absent is invisible. */
  canDerive: boolean;
  pickerOpen: boolean;
  onRecord: (emotion: string) => void;
  addVoice: (emotion: string, f: File) => void;
  openPicker: (emotion: string) => void;
  confirmRemove: (voiceId: string, label: string, shadowed?: boolean) => void;
  dropSlot: (emotion: string) => Promise<void>;
}) {
  return (
    <td className="px-3 py-2 text-right">
      {filled ? (
        <>
        {/* A measurement is only worth showing if it is
            actionable: a flagged slot gets the one action that
            fixes it, right where the flag is. It opens the SAME
            guided recorder as an empty slot — the recorder names
            the defect — and it is additive: nothing is deleted, the
            new take replaces the slot only once it is cloned. */}
        {derivedFrom && (
          // One click from computed to performed. Same guided
          // recorder every other slot opens — the derived voice is
          // only replaced once the real take is cloned, so this
          // costs nothing to start and nothing to abandon.
          <button onClick={() => onRecord(s.emotion)} disabled={isBusy}
            aria-label={`Promote the derived ${s.label} voice to a recording`}
            title={`Record ${name}'s own ${s.label} and replace this computed slot with it.`}
            className="font-jetbrains mr-3 text-[11px] text-violet-200/90 transition hover:text-violet-100 disabled:opacity-40">
            ↥ promote to recording
          </button>
        )}
        {signal?.flag && (
          <button onClick={() => onRecord(s.emotion)} disabled={isBusy}
            aria-label={`Re-record the ${s.label} voice`}
            title={`${signal.title} Re-record this slot with the fix in hand.`}
            className="font-jetbrains mr-3 text-[11px] text-amber-300/90 transition hover:text-amber-200 disabled:opacity-40">
            ↻ re-record
          </button>
        )}
        <button onClick={() => confirmRemove(s.voice!.voice_id, s.label)}
          disabled={removingVoiceId === s.voice!.voice_id}
          aria-label={`Remove the ${s.label} voice`}
          className="font-jetbrains text-[11px] text-white/55 transition hover:text-rose-300 disabled:opacity-40">
          {removingVoiceId === s.voice!.voice_id ? "removing…" : "remove"}
        </button>
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
          {canDerive && (
            <button onClick={() => openPicker(s.emotion)} disabled={isBusy}
              aria-expanded={pickerOpen}
              aria-label={`Derive the ${s.label} voice from another recording`}
              title="Compute this slot from a baseline plus an emotion direction taken from a voice that already has it. It will be marked as derived, never as recorded."
              className="font-jetbrains ml-3 text-[11px] text-violet-200/80 transition hover:text-violet-100 disabled:opacity-50">
              derive from…
            </button>
          )}
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
  );
}
