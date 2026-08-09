"use client";

// ── re-voice ─────────────────────────────────────────────────────────────────

import { useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { mediaUrl } from "./videoData";
import { StepsRail } from "./videoParts";
import { SlotRibbon } from "./dubParts";
import type { Dub, DubLine } from "./useDub";

export default function RevoiceStage({ dub, draft, onStage }: {
  dub: Dub; draft: DubLine[]; onStage: (t: string) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const j = dub.job;
  const summary = j?.result?.summary;
  // After a run the verdicts belong to the lines that produced them; before
  // one, the sheet being written is the only truth there is.
  const ribbon = dub.slots.length > 0
    ? dub.slots
    : draft.map((line) => ({ line, fit: null }));

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">source</span>
        <input
          type="url" value={dub.url} onChange={(e) => dub.setUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…" aria-label="Dialogue video link"
          disabled={j?.status === "running"}
          className="font-jetbrains min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-3 py-1.5 text-[12px] text-white/85 placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none disabled:opacity-50"
        />
        {j && j.status !== "running" && (
          <button
            onClick={() => void dub.reset()}
            className="font-jetbrains shrink-0 cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/70 transition hover:border-rose-400/40 hover:text-rose-200"
          >
            new dub
          </button>
        )}
      </div>

      {/* WHAT IS NOT HERE, said plainly: the source cannot be shown before the
          render. The box downloads it, replaces the speech and hands back one
          file — there is no preview of someone else's video to play in the
          meantime, and a black rectangle pretending otherwise would be worse. */}
      {!j && (
        <p className="font-jetbrains mt-2 text-[11px] text-white/55">
          The picture arrives with the dub — this box fetches the video, replaces its
          speech and returns the finished file. The strip below is the sheet you are
          writing, drawn on its own clock.
        </p>
      )}

      {j?.status === "running" && <div className="mt-4"><StepsRail job={j} stalled={dub.stalled} /></div>}
      {j?.status === "error" && <ErrorBanner>{j.error}</ErrorBanner>}
      {j?.status === "expired" && <ErrorBanner>this dub aged out on the box — run it again</ErrorBanner>}
      {/* cancelled is a real backend state (service/revoice_api.py::cancel) and
          it used to paint nothing at all. Amber: an abandoned run is not a
          failure, but the panel must not look like a dub that never happened. */}
      {j?.status === "cancelled" && (
        <ErrorBanner severity="warning">
          this dub was cancelled — nothing further will be rendered for it
        </ErrorBanner>
      )}

      {j?.status === "done" && dub.jobId && (
        <div className="mt-4 flex flex-col gap-4 lg:flex-row">
          <video
            src={mediaUrl("revoice", dub.jobId, "video")} controls
            className="w-full shrink-0 rounded-xl border border-white/10 bg-black lg:w-[360px]"
          />
          <div className="min-w-0 flex-1">
            <p className="mt-1 truncate text-base text-white">{j.source.title}</p>
            {summary && (
              <p className="font-jetbrains mt-1 text-[11px] text-white/55">
                {summary.lines} lines · {summary.verbatim} verbatim · {summary.atempo} time-stretched ·{" "}
                {summary.rewritten} rewritten
                {j.brain
                  ? ` · directed by ${j.brain.backend}${j.brain.model ? ` (${j.brain.model})` : ""}`
                  : ""}
              </p>
            )}
            {/* spilling = the dub rendered, with a caveat (warning · amber);
                failed = lines that are NOT in the file (error · rose). One
                banner component decides both, so the two can never swap hues. */}
            {!!summary?.spilling && (
              <ErrorBanner severity="warning" className="mt-1">
                {summary.spilling} line{summary.spilling > 1 ? "s" : ""} still run past their slot — the
                picture keeps playing under them
              </ErrorBanner>
            )}
            {!!summary?.failed && (
              <ErrorBanner className="mt-1">
                {summary.failed} line{summary.failed > 1 ? "s" : ""} could not be re-performed
              </ErrorBanner>
            )}
            <a href={mediaUrl("revoice", dub.jobId, "video")} download
               className="font-jetbrains mt-3 inline-block cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/70 transition hover:border-cyan-400/40 hover:text-cyan-200">
              download the dub
            </a>
          </div>
        </div>
      )}

      {ribbon.length > 0 && (
        <div className="mt-4">
          <SlotRibbon
            slots={ribbon}
            activeId={active}
            onPick={(line) => { setActive(line.id); onStage(line.text); }}
            height="h-14"
          />
          <p className="font-jetbrains mt-2 text-[11px] text-white/55">
            {dub.slots.length > 0
              ? "Click a slot to put its line in the composer — a take you render there is a replacement you keep in the log; the dub itself keeps what it was rendered with."
              : "The sheet on its clock. Overlapping blocks will speak over each other, and a gap is silence the original had words in."}
          </p>
        </div>
      )}

      {j?.limits?.length ? (
        <ErrorBanner severity="warning">{j.limits.join(" · ")}</ErrorBanner>
      ) : null}
    </>
  );
}
