"use client";

// /studio — the content studio, consolidated after two prototype rounds
// (mocked data throughout; scope in docs/studio-scope.md).
//
// Two views: PROJECT walks one production through five phases — each phase's
// surface is its round-2 winner (Manuscript, Lightbox, Shot lab, Spotting,
// Timeline). LIBRARY is round 1's winner (Shelves): every asset captioned,
// filed, and traceable to the direction that made it.

import { useState } from "react";

import AppFrame from "@/components/ui/AppFrame";
import { Eyebrow } from "@/components/ui/Primitives";

import { PROJECT, SCENES } from "./_studio/scenes";
import LibraryShelves from "./_library/LibraryShelves";
import ScriptManuscript from "./_phases/ScriptManuscript";
import FramesLightbox from "./_phases/FramesLightbox";
import MotionShotLab from "./_phases/MotionShotLab";
import ScoreSpotting from "./_phases/ScoreSpotting";
import CutTimeline from "./_phases/CutTimeline";

const PHASES = [
  {
    key: "script",
    title: "Script",
    sub: "story & scene plan",
    state: "approved — one open question on scene 5",
    render: () => <ScriptManuscript />,
  },
  {
    key: "frames",
    title: "Frames",
    sub: "stills per scene",
    state: "4 of 5 scenes picked",
    render: () => <FramesLightbox />,
  },
  {
    key: "motion",
    title: "Motion",
    sub: "video & vfx",
    state: "2 on film · 1 rejected · 1 rendering · 1 blocked",
    render: () => <MotionShotLab />,
  },
  {
    key: "score",
    title: "Score",
    sub: "music",
    state: "2 cues rendered · 1 refused",
    render: () => <ScoreSpotting />,
  },
  {
    key: "cut",
    title: "Cut",
    sub: "preview & sync",
    state: "playable with gaps — 4 blocks missing, 1 drift",
    render: () => <CutTimeline />,
  },
] as const;

export default function StudioPage() {
  const [view, setView] = useState<"project" | "library">("project");
  const [phaseKey, setPhaseKey] = useState<(typeof PHASES)[number]["key"]>("script");

  const phase = PHASES.find((p) => p.key === phaseKey) ?? PHASES[0];

  return (
    <AppFrame>
      <main className="pb-16">
        <header className="pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <Eyebrow>studio</Eyebrow>
            <span className="font-jetbrains rounded-full border border-amber-400/25 bg-amber-400/5 px-3 py-1 text-[11px] tracking-[0.18em] text-amber-300/90 uppercase">
              prototype · mocked data
            </span>
          </div>
          <h1 className="font-instrument mt-4 text-4xl text-white">
            {view === "project" ? PROJECT.title : "Every asset knows where it came from."}
          </h1>
          <p className="font-hanken mt-2 max-w-2xl text-base text-slate-400">
            {view === "project"
              ? `“${PROJECT.logline}” — ${SCENES.length} scenes, ${PROJECT.totalS} seconds, walked through five phases. Nothing here has touched a model yet.`
              : "One library for everything the studio makes — captioned so it's findable, filed with the direction that made it."}
          </p>
        </header>

        {/* view toggle: the production vs the shelves it fills */}
        <div className="font-jetbrains mt-6 flex gap-2 text-[12px]">
          {(
            [
              { key: "project", label: "Project" },
              { key: "library", label: "Library" },
            ] as const
          ).map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={`rounded-full border px-4 py-1.5 transition ${
                view === v.key
                  ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                  : "border-white/10 text-white/50 hover:text-white/80"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        {view === "library" ? (
          <LibraryShelves />
        ) : (
          <>
            {/* the lifecycle rail */}
            <ol className="mt-8 flex flex-wrap gap-2">
              {PHASES.map((p, i) => (
                <li key={p.key}>
                  <button
                    onClick={() => setPhaseKey(p.key)}
                    className={`rounded-xl border px-4 py-2.5 text-left transition ${
                      phaseKey === p.key
                        ? "border-cyan-400/40 bg-cyan-400/[0.07]"
                        : "border-white/8 bg-white/[0.02] hover:border-white/20"
                    }`}
                  >
                    <span className="font-jetbrains flex items-center gap-2 text-[11px] text-white/40">
                      <span
                        className={`grid h-5 w-5 place-items-center rounded-full border text-[10px] ${
                          phaseKey === p.key
                            ? "border-cyan-400/50 text-cyan-300"
                            : "border-white/15 text-white/50"
                        }`}
                      >
                        {i + 1}
                      </span>
                      {p.sub}
                    </span>
                    <span className="mt-1 block text-sm font-medium text-white">{p.title}</span>
                    <span className="font-jetbrains mt-0.5 block text-[11px] text-slate-500">
                      {p.state}
                    </span>
                  </button>
                </li>
              ))}
            </ol>

            <section className="mt-8">{phase.render()}</section>
          </>
        )}
      </main>
    </AppFrame>
  );
}
