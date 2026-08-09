"use client";

// RACK — operations metaphor, the sibling of the Character table. One dense row
// per emotion slot: status, sample, voice id, added, actions. Space-efficient and
// practical; every slot is visible at once with no scrolling or spatial hunting.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Fragment, useState } from "react";
import { useVoicePreview, deleteVoiceQuestion, type Slot } from "@/app/voices/_data/characters";
import EmotionAudition from "./EmotionAudition";
import EmotionDonorPicker from "./EmotionDonorPicker";
import EmotionPalettePanel from "./EmotionPalettePanel";
import EmotionShadowRow from "./EmotionShadowRow";
import EmotionSlotRow from "./EmotionSlotRow";
import { useEmotionRackDonors } from "./useEmotionRackDonors";

export default function EmotionRack({
  name, characterId, slots, coverage, total, busySlot, addVoice, removeVoice, onRecord,
  addCustomEmotion, removeCustomEmotion, removingVoiceId = null, deriveVoice,
}: {
  name: string;
  // The address the API actually answers on. Previously derived from `name` by
  // collapsing whitespace, which printed "mary-o'brien" for "Mary O'Brien" — a
  // copy-pasteable address that 404s. The server already told us the id; use it.
  characterId: string;
  slots: Slot[]; coverage: number; total: number; busySlot: string | null;
  addVoice: (emotion: string, f: File) => void; removeVoice: (id: string) => void;
  onRecord: (emotion: string) => void; // open the guided capture session
  addCustomEmotion: (name: string) => Promise<void>;
  removeCustomEmotion: (emotion: string) => Promise<void>;
  /** The voice whose DELETE is in flight — its remove button stops taking
   *  clicks instead of firing a second request behind the first. */
  removingVoiceId?: string | null;
  /** Compute an empty slot instead of recording it. OPTIONAL: where it is not
   *  supplied the third action simply does not exist — absent is invisible, the
   *  same rule the Signal chip follows. Must THROW the backend's reason so it can
   *  be shown against the row it belongs to. */
  deriveVoice?: (emotion: string, donor?: string | null) => Promise<unknown>;
}) {
  const { preview, playingId, busyId, failedId, failedReason } = useVoicePreview();
  const [err, setErr] = useState<string | null>(null);
  const missing = total - coverage;
  // Derived slots are NOT recordings, so they are counted (and labelled)
  // separately in the header. Folding them into "recorded" would be the exact
  // claim this whole feature must never make.
  const derivedCount = slots.filter((s) => s.voice?.origin === "derived").length;
  const recordedCount = coverage - derivedCount;

  // Which empty slot has its donor picker open, what is in flight, and the last
  // refusal — kept per-emotion so the reason renders against the row that earned
  // it rather than in a page-level banner.
  const donors = useEmotionRackDonors(characterId);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [derivingFrom, setDerivingFrom] = useState<string | null>(null);
  const [deriveError, setDeriveError] = useState<{ emotion: string; reason: string } | null>(null);

  function openPicker(emotion: string) {
    setDeriveError(null);
    setPickerFor((cur) => (cur === emotion ? null : emotion));
    void donors.load();
  }

  async function runDerive(emotion: string, donor: string | null) {
    if (!deriveVoice) return;
    setDerivingFrom(donor ?? "_basis");
    setDeriveError(null);
    try {
      await deriveVoice(emotion, donor);
      setPickerFor(null);
    } catch (e) {
      // The service's own sentence, verbatim. On a box without the embedding
      // stack this is a 501 that says so, and that IS the honest answer —
      // replacing it with "derive failed" would hide the one useful fact.
      setDeriveError({
        emotion,
        reason: e instanceof Error ? e.message : "this slot could not be derived",
      });
    } finally {
      setDerivingFrom(null);
    }
  }
  // Voices sharing a slot with the one that speaks. The registry tolerates them
  // so they can be deleted; coverage counts DISTINCT emotions, so without this
  // line nothing on the page would even hint they exist.
  const shadowed = slots.reduce((n, s) => n + Math.max(0, s.voices.length - 1), 0);

  /** Ask before destroying a cloned embedding.
   *
   *  Removing a Voice was the only single-click destruction on this page, next
   *  to a consent gate and an import rename that both stop and ask. It names
   *  the Character, the slot and the id, because "remove" on a dense rack of
   *  rows is otherwise a click whose target the user infers from the cursor. */
  function confirmRemove(voiceId: string, label: string, shadowed = false) {
    if (!window.confirm(deleteVoiceQuestion(name, label, voiceId, shadowed))) return;
    removeVoice(voiceId);
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
          {recordedCount}/{total} recorded
          {derivedCount > 0 && (
            <span
              className="ml-2 text-violet-200/80"
              title="Derived slots are computed from a baseline plus a shared emotion direction. They speak, but nobody performed them — record one to replace it."
            >
              · {derivedCount} derived
            </span>
          )}
          {missing > 0 && <span className="ml-2 text-amber-300/70">· {missing} fall back to baseline</span>}
          {shadowed > 0 && (
            <span
              className="ml-2 text-amber-300/70"
              title="Two voices occupy one slot. Only the first speaks; remove one to resolve it."
            >
              · {shadowed} shadowed
            </span>
          )}
        </span>
      </div>

      {err && <ErrorBanner className="mb-3">{err}</ErrorBanner>}

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
              // Extra voices registered on the same emotion. They never speak,
              // but they are real rows in the registry — each gets its own line
              // (and its own remove button) or it cannot be deleted at all.
              const shadows = s.voices.slice(1);
              const failedDerive = deriveError?.emotion === s.emotion ? deriveError.reason : null;

              return (
                <Fragment key={s.emotion}>
                <EmotionSlotRow
                  slot={s} name={name} shadows={shadows} busySlot={busySlot}
                  playingId={playingId} busyId={busyId}
                  failedId={failedId} failedReason={failedReason}
                  removingVoiceId={removingVoiceId} failedDerive={failedDerive}
                  canDerive={Boolean(deriveVoice)} pickerOpen={pickerFor === s.emotion}
                  preview={preview} onRecord={onRecord} addVoice={addVoice}
                  openPicker={openPicker} confirmRemove={confirmRemove} dropSlot={dropSlot}
                />

                {pickerFor === s.emotion && !s.voice && (
                  <EmotionDonorPicker
                    slot={s} donors={donors} derivingFrom={derivingFrom}
                    onDerive={(donor) => void runDerive(s.emotion, donor)}
                    onCancel={() => setPickerFor(null)}
                  />
                )}

                {shadows.map((v) => (
                  <EmotionShadowRow
                    key={v.voice_id} voice={v} slot={s} name={name}
                    preview={preview} playingId={playingId} busyId={busyId}
                    failedId={failedId} failedReason={failedReason}
                    removingVoiceId={removingVoiceId}
                    onRemove={() => confirmRemove(v.voice_id, s.label, true)}
                  />
                ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* The rack above is per-slot bookkeeping: one row, one voice, one
          preview at a time. The audition is the opposite reading of the same
          data — the WHOLE scale on one held-still line, so the range and the
          speaker's identity can be judged together. */}
      <EmotionAudition name={name} slots={slots} />

      {/* custom emotion palette — the scale is a platform primitive, not a constant */}
      <EmotionPalettePanel
        characterId={characterId} addCustomEmotion={addCustomEmotion} onError={setErr}
      />
    </div>
  );
}
