"use client";

import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { useMounted } from "@/lib/useMounted";
import {
  deleteCorpusClip, type CorpusClip, type CorpusView, type DeletionReport,
} from "@/app/voices/new/_state/corpus";

/** Deleting ONE kept recording: the gate, the request, and the service's report. */
export function useCorpusDeletion(
  characterId: string,
  mounted: ReturnType<typeof useMounted>,
  setView: Dispatch<SetStateAction<CorpusView | null>>,
) {
  // ── deletion ────────────────────────────────────────────────────────────────
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null); // the same fact, visible
  const [report, setReport] = useState<DeletionReport | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // The ATOMIC half of the gate. State cannot own it: two clicks inside one
  // React batch both read the pre-update `deleting`, so the second one would
  // fire a second DELETE — the same reason the studio's commit guards on a ref.
  const removing = useRef(false);

  async function remove(clip: CorpusClip) {
    if (removing.current) return; // one deletion at a time
    removing.current = true;
    setDeleting(clip.clip_sha256);
    setDeleteError(null);
    try {
      const r = await deleteCorpusClip(characterId, clip.clip_sha256);
      if (!mounted.current) return;
      setReport(r);
      setConfirming(null);
      // Drop the row locally so the list matches the report, and take the
      // service's own remaining-count rather than recomputing one here.
      setView((cur) => (cur ? {
        ...cur,
        clips: cur.clips.filter((c) => c.clip_sha256 !== clip.clip_sha256),
        totals: {
          ...cur.totals,
          clips: r.remaining.clips,
          bytes: r.remaining.bytes,
          segments: Math.max(0, cur.totals.segments - (r.removed?.segments ?? 0)),
          seconds: Math.round(Math.max(0, cur.totals.seconds - (r.removed?.seconds ?? 0)) * 100) / 100,
        },
        corpus_rev: r.corpus_rev ?? cur.corpus_rev,
      } : cur));
    } catch (e) {
      if (!mounted.current) return;
      // The true state after a failed DELETE: the recording is STILL kept.
      setDeleteError(
        `${e instanceof Error ? e.message : "the deletion failed"} — this recording is still kept on this box.`,
      );
    } finally {
      removing.current = false;
      if (mounted.current) setDeleting(null);
    }
  }

  return {
    confirming, setConfirming, deleting, report, setReport, deleteError, setDeleteError, remove,
  };
}
