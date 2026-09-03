"use client";

import { emotionMeta } from "@/lib/emotions";
import { formatBytes, type CorpusClip } from "@/app/voices/new/_state/corpus";

/** One kept recording: what it holds, what it was kept under, and its deletion. */
export default function CorpusClipRow({
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
