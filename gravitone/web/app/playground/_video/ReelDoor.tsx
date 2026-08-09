"use client";

// The door into a reel: a link, a note to the writer, and the Character the
// console already has selected. One component, two shapes — the bay wants a
// form, the marquee wants a bar — because the two directions must differ in
// where the picture LIVES, not in what it costs to load one.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button } from "@/components/ui/Primitives";
import { StepsRail } from "./parts";
import type { Reel } from "./useReel";

export default function ReelDoor({ reel, characterName, layout }: {
  reel: Reel;
  characterName: string | null;
  layout: "panel" | "bar";
}) {
  const blocked = !characterName
    ? "pick a Character above — it narrates the reel"
    : !reel.url.trim() ? "paste a link to the footage" : null;
  // WHO narrates is stated whether or not the door is ready to open: it is the
  // fusion this extension exists for (the rail's Character, not a second
  // picker), and hiding it behind "paste a link first" is how a user ends up
  // not knowing which voice they are about to commit a whole reel to.
  const narrator = characterName
    ? `${characterName} narrates`
    : "no Character selected";

  // Loading / failed / expired: the same three answers in both shapes.
  if (reel.jobId && reel.job) {
    const j = reel.job;
    return (
      <div className={layout === "panel" ? "px-5 py-4" : ""}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
              {j.status === "running" ? "reading the picture" : "reel"}
            </p>
            <p className="mt-1 truncate text-base text-white">{j.source.title ?? reel.url}</p>
          </div>
          <button
            onClick={() => void reel.reset()}
            className="font-jetbrains shrink-0 cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/70 transition hover:border-rose-400/40 hover:text-rose-200"
          >
            {j.status === "running" ? "cancel" : "new reel"}
          </button>
        </div>
        {j.status === "running" && <div className="mt-4"><StepsRail job={j} stalled={reel.stalled} /></div>}
        {j.status === "error" && <ErrorBanner>{j.error}</ErrorBanner>}
        {j.status === "expired" && (
          <ErrorBanner>this reel aged out on the box — load it again</ErrorBanner>
        )}
        {j.limits.length > 0 && j.status === "done" && (
          <ErrorBanner severity="warning">{j.limits.join(" · ")}</ErrorBanner>
        )}
      </div>
    );
  }

  const inputs = (
    <>
      <input
        type="url" value={reel.url} onChange={(e) => reel.setUrl(e.target.value)}
        placeholder="https://www.youtube.com/watch?v=…" aria-label="Footage link"
        className="font-jetbrains min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-3 py-1.5 text-[12px] text-white/85 placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none"
      />
      <input
        value={reel.style} onChange={(e) => reel.setStyle(e.target.value)}
        placeholder="a note to the writer — tone, pace, audience" aria-label="Style brief"
        className="font-jetbrains min-w-0 flex-1 rounded-lg border border-white/15 bg-black/40 px-3 py-1.5 text-[12px] text-white/85 placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none"
      />
    </>
  );

  if (layout === "bar") {
    return (
      <div className="glass-panel rounded-2xl px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">picture</span>
          {inputs}
          <button
            onClick={() => void reel.submit()}
            disabled={!!blocked || reel.submitting}
            title={blocked ?? "Read this footage and write its narration"}
            className="font-jetbrains shrink-0 cursor-pointer rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-[11px] text-cyan-200 transition enabled:hover:bg-cyan-400/20 disabled:opacity-40"
          >
            {reel.submitting ? "reading…" : "load reel"}
          </button>
        </div>
        <p className="font-jetbrains mt-2 text-[11px] text-white/55">
          <span className={characterName ? "text-white/75" : "text-amber-200/90"}>{narrator}</span>
          {" · one frame per scene is read, and the narration is written to each scene's length."}
          {blocked && characterName ? ` ${blocked}.` : ""}
        </p>
        {reel.error && <ErrorBanner>{reel.error}</ErrorBanner>}
      </div>
    );
  }

  return (
    <div className="px-5 py-4">
      <div className="flex flex-col gap-2">{inputs}</div>
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={() => void reel.submit()} disabled={!!blocked || reel.submitting}
                title={blocked ?? "Read this footage and write its narration"}>
          {reel.submitting ? "Reading…" : "Read the picture ▶"}
        </Button>
        <span className="font-jetbrains text-[11px] text-white/55">
          <span className={characterName ? "text-white/75" : "text-amber-200/90"}>{narrator}</span>
          {" · one frame per scene"}
          {blocked && characterName ? ` · ${blocked}` : ""}
        </span>
      </div>
      {reel.error && <ErrorBanner>{reel.error}</ErrorBanner>}
    </div>
  );
}
