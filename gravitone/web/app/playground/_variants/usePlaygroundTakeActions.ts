"use client";

// THE VERBS THE LOG INVOKES ON THE REST OF THE CONSOLE. Each of these three
// crosses a boundary — a take back into the composer, a take out of every piece
// of state that holds one, an edited region forward as a new take — which is
// exactly why they live together and not inside either side.

import { reconcileCharacters, type ComposerState } from "@/lib/composerStore";
import { DEFAULT_OUTPUT_FORMAT } from "@/lib/audioFormats";
import { deleteTake } from "@/lib/takeStore";
import { appendEdit, type Take } from "./shared";
import { dropVariants } from "./variantStore";
import type { CommitPayload } from "./PunchIn";
import type { usePlaygroundComposer } from "./usePlaygroundComposer";
import type { usePlaygroundTakes } from "./usePlaygroundTakes";
import type { usePlaygroundSharing } from "./usePlaygroundSharing";
import type { Character } from "@/app/voices/_data/characters";

export function usePlaygroundTakeActions({
  composer, takesApi, sharing, characters, charName, seq, composerRef,
  setCodeFor, setPunchFor, setComposerNotice,
}: {
  composer: ReturnType<typeof usePlaygroundComposer>;
  takesApi: ReturnType<typeof usePlaygroundTakes>;
  sharing: ReturnType<typeof usePlaygroundSharing>;
  characters: Character[];
  charName: (id: string) => string;
  seq: { current: number };
  composerRef: { current: HTMLDivElement | null };
  setCodeFor: (updater: (c: string | null) => string | null) => void;
  setPunchFor: (next: string | null | ((p: string | null) => string | null)) => void;
  setComposerNotice: (msg: string | null) => void;
}) {
  const { text, script, charId, setMode, setText, setScript, setActiveLine, setExpr, setCharId } = composer;
  const { setTakes, addTake, setAnnouncement } = takesApi;
  const { setReviewSel, setShares } = sharing;

  /** Load a take back into the composer, ready to re-run.
   *
   *  Every take already stores the text, Character and expression that produced
   *  it; without this, acting on "sad → nearest emotion" meant retyping the
   *  prompt from the ribbon. Characters that have since been deleted are
   *  reported, not silently swapped. */
  function reuseTake(t: Take) {
    const ids = characters.map((c) => c.character_id);
    const fallback = (charId && ids.includes(charId) ? charId : ids[0]) ?? "";
    const candidate: ComposerState = t.lines?.length
      ? {
          text, mode: "script", expr: { ...t.expr }, charId: t.characterId, activeLine: 0,
          script: t.lines.map((l, i) => ({
            id: `line-reuse-${t.id}-${i}`, characterId: l.character_id, text: l.text,
          })),
        }
      : { text: t.text, mode: "solo", expr: { ...t.expr }, charId: t.characterId, activeLine: 0, script };
    const { state, dropped } = reconcileCharacters(candidate, ids, fallback);
    setMode(state.mode);
    setText(state.text);
    setScript(state.script);
    setActiveLine(0);
    setExpr(state.expr);
    setCharId(state.charId);
    setComposerNotice(dropped.length > 0
      ? `Loaded into the composer, but ${dropped.join(", ")} no longer exists — those lines now use ${charName(state.charId)}.`
      : null);
    composerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /** Delete a take: revoke its object URL, drop it from the store + all state. */
  function removeTake(id: string) {
    setTakes((list) => {
      const t = list.find((x) => x.id === id);
      if (t?.url) URL.revokeObjectURL(t.url);
      return list.filter((x) => x.id !== id);
    });
    setReviewSel((s) => { const n = new Set(s); n.delete(id); return n; });
    setCodeFor((c) => (c === id ? null : c));
    setPunchFor((p) => (p === id ? null : p));
    setShares((s) => { const { [id]: _, ...rest } = s; return rest; });
    void deleteTake(id);
    // A deleted take's audition lanes are orphaned audio — the one thing the
    // variant store must never accumulate.
    void dropVariants(id);
  }

  /**
   * Commit a punched region: the spliced master becomes a NEW take.
   *
   * The original is untouched and stays in the log — an editor that overwrites
   * the thing you were comparing against is not an editor. The new take inherits
   * the base's identity (Character, script, text) and carries `edits`, so its
   * code export prints the base call plus every patch call (see TakeCode).
   */
  function commitPunch(base: Take, p: CommitPayload) {
    seq.current += 1;
    const take: Take = {
      ...base,
      id: `take-${Date.now()}-${seq.current}`,
      url: URL.createObjectURL(p.blob),
      blob: p.blob,
      peaks: p.peaks,
      seconds: p.seconds,
      kb: Math.round(p.blob.size / 1024),
      // A splice has no whole-call realtime factor to report: part of this audio
      // was rendered minutes ago. Reporting the patch render's rtf as the take's
      // would let a one-segment render calibrate the estimate for a whole take,
      // so the timing fields carry ONLY what was measured (the patch), rtf stays
      // 0 and no timingVersion is stamped — isTimingBasis therefore skips it.
      rtf: 0,
      synthSeconds: p.synthSeconds,
      queueSeconds: p.queueSeconds,
      timingVersion: undefined,
      segments: p.segments,
      // The master is always wav (engine.spliceRegion), whatever the base was.
      format: DEFAULT_OUTPUT_FORMAT,
      createdAt: Date.now(),
      edits: appendEdit(base, p.region),
      // Whatever made the BASE fall back is not a property of this splice.
      fallbackReason: undefined,
      fallbackDetail: undefined,
    };
    addTake(take);
    // addTake's generic announcement is true but says nothing about the edit,
    // which is the whole event here.
    setAnnouncement(
      `Punched take ready — segment ${p.region.i + 1} replaced, ${take.seconds} seconds total. ` +
      `The original take is still in the log.`,
    );
    // Keep the editor open on the RESULT: the loop this feature exists for is
    // fix, listen, fix the next one.
    setPunchFor(take.id);
  }

  return { reuseTake, removeTake, commitPunch };
}
