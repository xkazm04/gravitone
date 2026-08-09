"use client";

import { useCallback, useEffect, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useMounted } from "@/lib/useMounted";
import { formatBytes, loadCorpus, type CorpusView } from "@/app/voices/new/_state/corpus";
import CorpusClipRow from "./CorpusClipRow";
import CorpusRebuildPanel from "./CorpusRebuildPanel";
import { useCorpusDeletion } from "./useCorpusDeletion";
import { useCorpusRebuild } from "./useCorpusRebuild";

/**
 * What this box KEEPS of a person — and the two things a user must be able to
 * do about it.
 *
 * The service has held the whole retention loop for a while and the web
 * delivered none of it: audio captured under an opt-in, itemized down to the
 * segment, with the consent receipt it was kept under — plus a deletion that
 * reports what went, and a re-derivation that rebuilds this character's voices
 * from everything kept, best-of across takes, with no upload and no cloud call.
 *
 * Three commitments:
 *   * **Nothing kept is nothing kept.** A character with no corpus (every
 *     character created before the opt-in existed) renders an honest empty
 *     state. It is not an error, and it must never look like one — the service
 *     answers it as a 200 with zero clips for exactly this reason.
 *   * **A deletion is shown, twice.** Before: what this recording holds, from
 *     the listing, next to what deletion does NOT touch (the voices already
 *     cloned from it). After: the service's own report of what went.
 *   * **A rebuild is a job, and it says so.** It polls the same surface a
 *     commit does — including the terminal states nobody likes: a failure names
 *     itself, and an abandoned rebuild says that the emotions it finished were
 *     KEPT (the service does not roll a re-derivation back, and pretending
 *     otherwise would describe a character that does not exist).
 */
export default function CorpusPanel({
  characterId, onRebuilt,
}: {
  characterId: string;
  /** The rebuild replaced voices — the page's own character data is now stale. */
  onRebuilt?: () => void;
}) {
  const mounted = useMounted();
  const [view, setView] = useState<CorpusView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const v = await loadCorpus(characterId, signal);
      if (!mounted.current || signal?.aborted) return;
      setView(v); setLoadError(null);
    } catch (e) {
      if (!mounted.current || signal?.aborted) return;
      // A failed READ is never rendered as an empty corpus: "we could not check"
      // and "nothing is kept" are opposite answers on this surface.
      setView(null);
      setLoadError(e instanceof Error ? e.message : "the kept recordings could not be read");
    } finally {
      if (mounted.current && !signal?.aborted) setLoading(false);
    }
  }, [characterId, mounted]);

  useEffect(() => {
    const ctrl = new AbortController();
    void refresh(ctrl.signal);
    return () => ctrl.abort();
  }, [refresh]);

  const {
    confirming, setConfirming, deleting, report, setReport, deleteError, setDeleteError, remove,
  } = useCorpusDeletion(characterId, mounted, setView);

  const rebuild = useCorpusRebuild(characterId, mounted, onRebuilt);

  const clips = view?.clips ?? [];

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-instrument text-2xl text-white">What this box keeps</h2>
          <p className="mt-1 max-w-2xl text-sm text-white/60">
            Recordings you chose to keep when you cloned from them — the audio, its
            segment labels and the attestation each was kept under. It never leaves
            this machine, it is the material a rebuild draws on, and every recording
            here can be deleted on its own.
          </p>
        </div>
        {view && view.totals.clips > 0 && (
          <span className="font-jetbrains rounded-full border border-white/12 px-3 py-1 text-[11px] text-white/60">
            {view.totals.clips} recording{view.totals.clips === 1 ? "" : "s"} ·{" "}
            {view.totals.seconds}s · {formatBytes(view.totals.bytes)}
            {view.cap_bytes ? ` of ${formatBytes(view.cap_bytes)}` : ""}
          </span>
        )}
      </div>

      {loadError && (
        <>
          <ErrorBanner>{loadError}</ErrorBanner>
          <p className="mt-2 text-sm text-white/60">
            That is a failed read, not an empty corpus — whatever is kept for this
            character is untouched.{" "}
            <button onClick={() => void refresh()} disabled={loading}
              className="cursor-pointer underline decoration-dotted transition hover:text-white disabled:opacity-50">
              {loading ? "retrying…" : "retry"}
            </button>
          </p>
        </>
      )}

      {loading && !view && !loadError && (
        <p className="font-jetbrains mt-4 text-[12px] text-white/45">reading what is kept…</p>
      )}

      {/* Over the cap the service REFUSES a rebuild (409) — say so where the
          button is, not after it has been pressed. */}
      {view?.over_cap && (
        <ErrorBanner severity="warning">
          this character&apos;s kept audio is over the {formatBytes(view.cap_bytes)} cap —
          a rebuild is refused until you delete a recording below.
        </ErrorBanner>
      )}

      {view && clips.length === 0 && !loadError && (
        <div className="glass-panel mt-4 rounded-2xl p-5">
          <p className="text-sm text-white/70">Nothing is kept for this character.</p>
          <p className="font-jetbrains mt-2 max-w-2xl text-[11px] leading-relaxed text-white/45">
            Keeping the source audio is opt-in per recording, and it was not asked for
            (or this character predates the option). The voices themselves are
            unaffected — they are already cloned. To build a corpus, tick{" "}
            <span className="text-white/70">keep this recording</span> next time you
            scan a recording into this character.
          </p>
        </div>
      )}

      {/* The deletion report — the service's own itemized answer, kept on
          screen until dismissed. A deletion the user cannot see the shape of is
          one they have to take on trust. */}
      {report?.removed && (
        <div className="mt-4 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.04] p-4">
          <div className="font-jetbrains text-[11px] uppercase tracking-widest text-emerald-200/80">
            deleted
          </div>
          <p className="mt-1 text-sm text-white/75">
            {report.removed.segments} segment{report.removed.segments === 1 ? "" : "s"} of
            audio ({report.removed.seconds}s), {report.removed.segment_labels} label
            {report.removed.segment_labels === 1 ? "" : "s"} and {report.removed.stems} stem
            {report.removed.stems === 1 ? "" : "s"} removed —{" "}
            {formatBytes(report.removed.bytes)} freed. {report.remaining.clips} recording
            {report.remaining.clips === 1 ? "" : "s"} still kept
            ({formatBytes(report.remaining.bytes)}).
          </p>
          {/* The files-would-not-delete case is an operator fact, not a footnote. */}
          {(report.reason || !report.removed.files_deleted) && (
            <ErrorBanner severity="warning" className="mt-3">
              {report.reason ?? "some of this recording's files could not be deleted from disk"}
            </ErrorBanner>
          )}
          <button onClick={() => setReport(null)}
            className="font-jetbrains mt-3 cursor-pointer text-[11px] text-white/50 underline decoration-dotted transition hover:text-white">
            dismiss
          </button>
        </div>
      )}
      {deleteError && <ErrorBanner>{deleteError}</ErrorBanner>}

      {clips.length > 0 && (
        <ul className="mt-4 space-y-3">
          {clips.map((clip) => (
            <CorpusClipRow
              key={clip.clip_sha256}
              clip={clip}
              confirming={confirming === clip.clip_sha256}
              deleting={deleting === clip.clip_sha256}
              anyDeleting={deleting !== null}
              onAskDelete={() => { setDeleteError(null); setConfirming(clip.clip_sha256); }}
              onCancelDelete={() => setConfirming(null)}
              onConfirmDelete={() => void remove(clip)}
            />
          ))}
        </ul>
      )}

      {/* REBUILD — the pay-off of keeping anything at all. */}
      {clips.length > 0 && (
        <CorpusRebuildPanel
          starting={rebuild.starting} busyRebuilding={rebuild.busyRebuilding}
          rederiveError={rebuild.rederiveError} stalled={rebuild.stalled}
          done={rebuild.done} failed={rebuild.failed} stopped={rebuild.stopped}
          job={rebuild.job} rebuild={rebuild.rebuild}
        />
      )}
    </section>
  );
}
