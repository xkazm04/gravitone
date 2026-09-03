"use client";

// ── narrate ──────────────────────────────────────────────────────────────────

import { useRef } from "react";
import { frameUrl, mediaUrl, substitution } from "./videoData";
import { FitMeter, tc } from "./videoParts";
import MarqueePlayhead from "./MarqueePlayhead";
import ReelDoor from "./ReelDoor";
import type { Reel, Scene } from "./useReel";

/** What was substituted for this scene's emotion, if anything — the writer's
 *  request against what the Character could actually speak. */
function sceneSwap(s: Scene): string | null {
  return substitution({
    requested: s.emotionRequested,
    delivered: s.fit?.emotion ?? s.emotion,
    stemFallback: s.fit?.stem_fallback,
  });
}

export default function NarrateStage({ reel, characterName, onStage }: {
  reel: Reel; characterName: string | null; onStage: (t: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Before a reel lands the stage IS the door — same strip, same panel, so the
  // console does not jump when the picture arrives.
  if (!reel.ready || !reel.jobId) {
    return <ReelDoor reel={reel} characterName={characterName} />;
  }

  const total = reel.scenes.reduce((a, s) => a + s.budget, 0) || 1;
  const focused = reel.scenes.find((s) => s.i === reel.focus) ?? null;

  const go = (s: Scene) => {
    reel.setFocus(s.i);
    onStage(s.text);
    const v = videoRef.current;
    if (v) {
      v.currentTime = s.start + 0.05; // land inside the block, never on its seam
      // play() is only a promise where the media stack implements one; the
      // seek above is the part that must land either way.
      void v.play()?.catch(() => { /* autoplay refused — the seek still landed */ });
    }
  };

  return (
    <>
      <div className="flex flex-col gap-4 lg:flex-row">
        <video
          ref={videoRef}
          src={mediaUrl("voiceover", reel.jobId, "video")}
          controls
          className="w-full shrink-0 rounded-xl border border-white/10 bg-black lg:w-[360px]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">picture</p>
              <p className="mt-1 truncate text-base text-white">{reel.job?.source.title}</p>
              <p className="font-jetbrains mt-1 text-[11px] text-white/55">
                {tc(total)} · {reel.scenes.length} scenes · narrated by {characterName}
                {reel.job?.brain
                  ? ` · written by ${reel.job.brain.backend}${
                      reel.job.brain.model ? ` (${reel.job.brain.model})` : ""}`
                  : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {/* the narrated reel leaves the same way the dub does — the only
                  exit used to be the browser's own context menu, unstated */}
              <a
                href={mediaUrl("voiceover", reel.jobId, "video")} download
                className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/70 transition hover:border-cyan-400/40 hover:text-cyan-200"
              >
                download the reel
              </a>
              <button
                onClick={() => void reel.reset()}
                className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/70 transition hover:border-rose-400/40 hover:text-rose-200"
              >
                new reel
              </button>
            </div>
          </div>

          {focused && (
            <div className="mt-3 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.04] p-3">
              <p className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-200">
                scene {focused.i + 1} in the composer · {focused.budget.toFixed(1)}s of picture
              </p>
              <p className="mt-1 line-clamp-2 text-sm text-white/80">
                {focused.text || "(the writer left this scene silent)"}
              </p>
              {/* A stated fact, not an alarm: the writer asked for an emotion
                  this Character has never recorded, so something else spoke the
                  line. It used to be computed (useReel: emotionRequested,
                  fit.stem_fallback) and shown nowhere. */}
              {sceneSwap(focused) && (
                <p className="font-jetbrains mt-1 text-[11px] text-white/50">{sceneSwap(focused)}</p>
              )}
              {focused.fit && <div className="mt-2"><FitMeter fit={focused.fit} /></div>}
            </div>
          )}
        </div>
      </div>

      {/* the ribbon — the reel's clock, to scale */}
      <div className="mt-4">
        <div className="relative flex h-20 w-full gap-[3px] overflow-hidden rounded-lg" role="group" aria-label="Scenes">
          {reel.scenes.map((s) => {
            const on = s.i === reel.focus;
            return (
              <button
                key={s.i}
                onClick={() => go(s)}
                aria-pressed={on}
                title={[`Scene ${s.i + 1}`, tc(s.start), `${s.budget.toFixed(1)}s`, sceneSwap(s)]
                  .filter(Boolean).join(" · ")}
                style={{ width: `${(s.budget / total) * 100}%` }}
                className={`group relative min-w-[10px] cursor-pointer overflow-hidden rounded-md border transition ${
                  on ? "border-cyan-400/60" : "border-white/10 hover:border-white/35"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={frameUrl(reel.jobId!, s.i)} alt=""
                  className={`absolute inset-0 h-full w-full object-cover transition ${on ? "opacity-70" : "opacity-35 group-hover:opacity-55"}`}
                />
                <span className="absolute inset-x-0 bottom-0 h-[3px]">
                  {s.fit && <FitMeter fit={s.fit} compact />}
                </span>
                <span className="font-jetbrains absolute left-1 top-1 rounded bg-black/50 px-1 text-[10px] text-white/80">
                  {s.i + 1}
                </span>
              </button>
            );
          })}
          <MarqueePlayhead videoRef={videoRef} total={total} />
        </div>
        <p className="font-jetbrains mt-2 text-[11px] text-white/55">
          Click a scene to load its line into the composer below — the score, the emotion
          wheel and the expression knobs are the ones you already use. The reel keeps the
          narration it was built with; what you render here lands in the take log.
        </p>
      </div>
    </>
  );
}
