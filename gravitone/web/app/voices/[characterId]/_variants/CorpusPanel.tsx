"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { emotionMeta } from "@/lib/emotions";
import { useMounted } from "@/lib/useMounted";
import {
  deleteCorpusClip, formatBytes, loadCorpus, startRederive,
  type CorpusClip, type CorpusView, type DeletionReport,
} from "@/app/voices/new/_state/corpus";
import { useIngestJob } from "@/app/voices/new/_state/useIngestJob";
import type { Job } from "@/app/voices/new/_state/machine";

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

  // ── re-derivation ───────────────────────────────────────────────────────────
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [rederiveError, setRederiveError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [stalled, setStalled] = useState(false);
  const announced = useRef(false);

  const done = job?.status === "committed";
  const failed = job?.status === "error";
  const stopped = job?.status === "cancelled" || expired;
  useIngestJob({
    jobId,
    // The same poller the studio uses for the analyze and commit legs: one
    // cadence, one terminal-stop rule, one 404-means-expired answer.
    enabled: Boolean(jobId) && !done && !failed && !stopped,
    onJob: setJob,
    onExpired: () => setExpired(true),
    onStalled: setStalled,
  });

  // The rebuild REPLACED voices, so the page above is showing stale ones. Fire
  // once, on the transition into 'committed'.
  useEffect(() => {
    if (!done || announced.current) return;
    announced.current = true;
    onRebuilt?.();
  }, [done, onRebuilt]);

  const kicking = useRef(false); // atomic gate — see `removing` above

  async function rebuild() {
    if (kicking.current || (jobId && !done && !failed && !stopped)) return;
    kicking.current = true;
    setStarting(true);
    setRederiveError(null); setExpired(false); setJob(null); setStalled(false);
    announced.current = false;
    try {
      const started = await startRederive(characterId);
      if (!mounted.current) return;
      setJobId(started.job_id);
    } catch (e) {
      if (!mounted.current) return;
      // 404 (nothing kept), 409 (over cap / nothing matched) and 429 all arrive
      // here as the service's own sentence — that is the whole reason the
      // refusals are synchronous.
      setRederiveError(e instanceof Error ? e.message : "the rebuild could not be started");
    } finally {
      kicking.current = false;
      if (mounted.current) setStarting(false);
    }
  }

  const clips = view?.clips ?? [];
  const busyRebuilding = Boolean(jobId) && !done && !failed && !stopped;

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
            <ClipRow
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
        <div className="glass-panel mt-4 rounded-2xl p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xl text-sm text-white/65">
              Rebuild this character&apos;s voices from everything kept above — best take
              per emotion across every recording, on this machine, with no upload and no
              new consent (the receipt stored with the audio is the consent). Existing
              voices are replaced.
            </p>
            <button
              onClick={() => void rebuild()}
              disabled={starting || busyRebuilding}
              className="font-jetbrains shrink-0 cursor-pointer rounded-full border border-cyan-400/35 bg-cyan-400/10 px-4 py-2 text-[12px] text-cyan-100 transition hover:bg-cyan-400/20 disabled:cursor-default disabled:opacity-45"
            >
              {starting ? "starting…" : busyRebuilding ? "rebuilding…" : "↻ rebuild from kept audio"}
            </button>
          </div>

          {rederiveError && <ErrorBanner>{rederiveError}</ErrorBanner>}

          {busyRebuilding && (
            <div className="font-jetbrains mt-3 text-[11px] text-white/60">
              rebuilding {job?.partial?.emotions_done ?? 0}/{job?.partial?.emotions_total ?? "?"}
              {job?.partial?.current ? ` · ${emotionMeta(job.partial.current).label}` : ""}
              {" — this loads the TTS model on this box, so it takes a while."}
            </div>
          )}
          {stalled && busyRebuilding && (
            <ErrorBanner severity="warning">
              connection to the studio is degraded — retrying. The rebuild keeps running
              server-side.
            </ErrorBanner>
          )}
          {done && (
            <p className="font-jetbrains mt-3 rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-[11px] text-emerald-200/85">
              rebuilt {job?.committed?.length ?? 0} voice
              {(job?.committed?.length ?? 0) === 1 ? "" : "s"} from the kept audio.
            </p>
          )}
          {failed && (
            <ErrorBanner>
              {job?.error ?? "the rebuild failed"} — every emotion it had already
              rebuilt was kept.
            </ErrorBanner>
          )}
          {stopped && !failed && (
            <ErrorBanner severity="warning">
              the rebuild ended before it finished. A re-derivation is never rolled
              back, so the emotions it completed are kept — the rest are unchanged.
            </ErrorBanner>
          )}
        </div>
      )}
    </section>
  );
}

/** One kept recording: what it holds, what it was kept under, and its deletion. */
function ClipRow({
  clip, confirming, deleting, anyDeleting,
  onAskDelete, onCancelDelete, onConfirmDelete,
}: {
  clip: CorpusClip;
  confirming: boolean;
  deleting: boolean;
  anyDeleting: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const added = clip.added ? Date.parse(clip.added) : NaN;
  const identity = clip.fidelity?.stem_identity ?? null;
  const emotions = Object.entries(clip.emotions);
  return (
    <li className="glass-panel rounded-2xl p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-jetbrains flex flex-wrap items-center gap-2 text-[11px] text-white/60">
            <span className="text-white/80">
              {Number.isNaN(added) ? "kept" : new Date(added).toLocaleString()}
            </span>
            <span>· {clip.seconds}s · {clip.segments} segment{clip.segments === 1 ? "" : "s"}</span>
            {clip.segments_recorded > clip.segments && (
              <span
                title="labels the scan produced whose audio was not kept (rejected or unusable segments)"
                className="text-white/40"
              >
                ({clip.segments_recorded - clip.segments} label
                {clip.segments_recorded - clip.segments === 1 ? "" : "s"} without audio)
              </span>
            )}
            <span>· {formatBytes(clip.bytes)}</span>
            {clip.mode && (
              <span className="rounded-full border border-white/12 px-2 py-0.5 text-[10px] text-white/55">
                {clip.mode}
              </span>
            )}
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {emotions.map(([emotion, e]) => {
              const m = emotionMeta(emotion);
              const id = identity?.[emotion];
              return (
                <span key={emotion}
                  title={typeof id === "number"
                    ? `Identity match: how closely this stem still sounds like the same speaker (1.00 is identical). ${clip.fidelity?.measures ?? ""}`.trim()
                    : "speaker identity was not measured for this stem"}
                  className="font-jetbrains inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] text-white/75">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${m.hue} 80% 62%)` }} />
                  {m.label} · {e.seconds}s
                  {/* Absent is a STATE, not a gap to fill with a zero. */}
                  {typeof id === "number" && (
                    <span className="text-cyan-200/80">identity {id.toFixed(2)}</span>
                  )}
                </span>
              );
            })}
            {emotions.length === 0 && (
              <span className="font-jetbrains text-[11px] text-white/40">
                no segment audio was kept for this recording
              </span>
            )}
          </div>

          {/* The receipt. It is the reason keeping this is defensible, so it is
              quoted, not summarised. */}
          <p className="font-jetbrains mt-2 max-w-2xl text-[10px] leading-relaxed text-white/40">
            kept under: “{clip.consent.statement ?? "no statement was stored"}”
            {clip.consent.consented_at && (() => {
              const t = Date.parse(clip.consent.consented_at);
              return Number.isNaN(t) ? null : ` · ${new Date(t).toLocaleString()}`;
            })()}
            {clip.voices.length > 0 &&
              ` · ${clip.voices.length} voice${clip.voices.length === 1 ? "" : "s"} were cloned from it`}
          </p>
        </div>

        <div className="shrink-0">
          {!confirming ? (
            <button
              onClick={onAskDelete}
              disabled={anyDeleting}
              className="font-jetbrains cursor-pointer rounded-full border border-rose-400/30 px-3 py-1 text-[11px] text-rose-200/90 transition hover:bg-rose-400/10 disabled:cursor-default disabled:opacity-40"
            >
              delete recording
            </button>
          ) : (
            <div className="max-w-xs rounded-xl border border-rose-400/25 bg-rose-400/[0.04] p-3">
              {/* What deletion takes, and what it leaves — stated BEFORE the
                  click, from this listing's own numbers. */}
              <p className="text-[12px] leading-snug text-rose-100/90">
                Delete {clip.segments} segment{clip.segments === 1 ? "" : "s"} ({clip.seconds}s)
                and {clip.stems.length} stem{clip.stems.length === 1 ? "" : "s"}, permanently?
              </p>
              <p className="font-jetbrains mt-1 text-[10px] leading-relaxed text-white/45">
                {clip.voices.length > 0
                  ? `The ${clip.voices.length} voice${clip.voices.length === 1 ? "" : "s"} already cloned from it stay — delete those from the rack above. `
                  : "Voices already cloned from it are not touched. "}
                A future rebuild will no longer have this recording to draw on.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={onConfirmDelete}
                  disabled={deleting}
                  className="font-jetbrains cursor-pointer rounded-full border border-rose-400/40 bg-rose-400/10 px-3 py-1 text-[11px] text-rose-100 transition hover:bg-rose-400/20 disabled:cursor-default disabled:opacity-45"
                >
                  {deleting ? "deleting…" : "delete it"}
                </button>
                <button
                  onClick={onCancelDelete}
                  disabled={deleting}
                  className="font-jetbrains cursor-pointer rounded-full border border-white/15 px-3 py-1 text-[11px] text-white/70 transition hover:bg-white/5 disabled:opacity-45"
                >
                  keep it
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
