"use client";

// DIRECTION 1 — CONTAINMENT. The picture lives INSIDE the compose bay, as a
// fourth thing the bay can hold (beside solo, script and live). The console's
// shape is untouched: the Character rail still picks the narrator, the
// expression panel still holds the model's real knobs, the footer still owns
// format + Generate, and takes still land in the log below.
//
// The reel owns its WORDS: every scene is a row you can edit in place, all of
// them visible at once, the document you are working on. The focused row is
// mirrored into the console's own composer text, so Generate renders exactly
// what the row says — no second synthesis path, no second set of knobs.

import { useEffect } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { frameUrl, mediaUrl } from "./data";
import { FitMeter, tc } from "./parts";
import ReelDoor from "./ReelDoor";
import type { Reel, Scene } from "./useReel";

export default function ReelBay({ reel, characterName, emotions, onStage }: {
  reel: Reel;
  characterName: string | null;
  /** what this Character has actually recorded — the only honest menu */
  emotions: string[];
  /** put these words in the console's composer, so its Generate renders them */
  onStage: (text: string) => void;
}) {
  const focused = reel.scenes.find((s) => s.i === reel.focus) ?? null;

  // The focused row IS the composer's text. One direction of flow, so an edit
  // in a row can never disagree with what Generate is about to render.
  useEffect(() => {
    if (focused) onStage(focused.text);
  }, [focused, focused?.text, onStage]);

  if (!reel.ready) {
    return <ReelDoor reel={reel} characterName={characterName} layout="panel" />;
  }

  return (
    <div className="px-5 py-4">
      {reel.jobId && (
        <video
          src={mediaUrl("voiceover", reel.jobId, "video")}
          controls
          className="max-h-56 w-full rounded-xl border border-white/10 bg-black"
        />
      )}
      <p className="font-jetbrains mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] uppercase tracking-widest text-white/60">
        <span>scenes — each row is one line of narration</span>
        <button
          onClick={() => void reel.reset()}
          className="cursor-pointer normal-case tracking-normal text-white/55 transition hover:text-rose-200"
        >
          new reel
        </button>
      </p>

      <div className="mt-3 space-y-2">
        {reel.scenes.map((s) => (
          <Row
            key={s.i}
            scene={s}
            jobId={reel.jobId!}
            focused={s.i === reel.focus}
            emotions={emotions}
            onFocus={() => reel.setFocus(s.i)}
            onText={(t) => reel.patch(s.i, { text: t })}
            onEmotion={(e) => reel.patch(s.i, { emotion: e })}
          />
        ))}
      </div>

      <p className="font-jetbrains mt-3 border-t border-white/8 pt-3 text-[11px] leading-relaxed text-white/55">
        Generate renders the focused row as a take, with the Character, expression and
        format this console already has set. The reel&apos;s own mp4 keeps the narration it
        was built with — a take made here is a replacement you keep in the log, not a
        re-cut of the video.
      </p>
    </div>
  );
}

function Row({ scene, jobId, focused, emotions, onFocus, onText, onEmotion }: {
  scene: Scene;
  jobId: string;
  focused: boolean;
  emotions: string[];
  onFocus: () => void;
  onText: (t: string) => void;
  onEmotion: (e: string) => void;
}) {
  return (
    <div
      onFocusCapture={onFocus}
      className={`grid gap-3 rounded-xl border p-2.5 transition sm:grid-cols-[132px_1fr_168px] ${
        focused ? "border-cyan-400/35 bg-cyan-400/[0.04]" : "border-white/8 hover:border-white/20"
      }`}
    >
      <button onClick={onFocus} className="cursor-pointer text-left" aria-label={`Focus scene ${scene.i + 1}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={frameUrl(jobId, scene.i)} alt={`scene ${scene.i + 1}`}
          className={`aspect-video w-full rounded-lg border object-cover transition ${
            focused ? "border-cyan-400/40" : "border-white/10 opacity-75"
          }`}
        />
        <span className="font-jetbrains mt-1 block text-[11px] text-white/55">
          #{scene.i + 1} · {tc(scene.start)} · {scene.budget.toFixed(1)}s
        </span>
      </button>

      <div className="min-w-0">
        <textarea
          value={scene.text}
          onChange={(e) => onText(e.target.value)}
          rows={3}
          placeholder="(the writer left this scene silent — write something to speak over it)"
          aria-label={`Scene ${scene.i + 1} narration`}
          className="w-full resize-none rounded-lg border border-white/12 bg-black/30 px-3 py-2 text-base text-white/90 placeholder:text-white/35 focus:border-cyan-400/40 focus:outline-none"
        />
        <div className="font-jetbrains mt-1 flex flex-wrap gap-x-3 text-[11px] text-white/50">
          <span>{scene.text.trim() ? scene.text.trim().split(/\s+/).length : 0}/{scene.budgetWords} words</span>
          {scene.edited && <span className="text-cyan-200">edited — the reel still holds the original</span>}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <select
          value={emotions.includes(scene.emotion) ? scene.emotion : "baseline"}
          onChange={(e) => onEmotion(e.target.value)}
          aria-label={`Scene ${scene.i + 1} emotion`}
          className="font-jetbrains w-full cursor-pointer rounded-lg border border-white/12 bg-black/40 px-2 py-1.5 text-[11px] text-white/85 focus:border-cyan-400/40 focus:outline-none"
        >
          {(emotions.length ? emotions : ["baseline"]).map((e) => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>
        {scene.fit && <FitMeter fit={scene.fit} />}
        {scene.emotionRequested && (
          <ErrorBanner severity="warning" className="mt-0">
            writer asked for {scene.emotionRequested} — not recorded for this Character
          </ErrorBanner>
        )}
      </div>
    </div>
  );
}
