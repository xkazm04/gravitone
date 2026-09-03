"use client";

// FRAMES / LIGHTBOX — the winner. One scene at a time, at size: the canvas
// dominates, candidates ride a filmstrip beneath, composition is named
// controls on the right. Polish round made the pick a real verb — the
// button commits it, the scene chips lose their amber dot when resolved.

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { SCENES } from "../_studio/scenes";
import { FrameThumb } from "../_studio/projectParts";

const SHOT_SIZES = ["wide", "medium", "close", "macro"];
const PALETTES = ["sodium night", "steel blue", "dawn amber"];

export default function FramesLightbox() {
  const [sceneId, setSceneId] = useState(SCENES[0].id);
  const [picks, setPicks] = useState<Record<string, string | null>>(
    Object.fromEntries(SCENES.map((s) => [s.id, s.pickedFrameId])),
  );
  const scene = SCENES.find((s) => s.id === sceneId) ?? SCENES[0];
  const [frameId, setFrameId] = useState<string | null>(picks[scene.id] ?? scene.frames[0].id);
  const frame = scene.frames.find((f) => f.id === frameId) ?? scene.frames[0];
  const pick = picks[scene.id];

  const selectScene = (id: string) => {
    const next = SCENES.find((s) => s.id === id)!;
    setSceneId(id);
    setFrameId(picks[next.id] ?? next.frames[0].id);
  };
  const step = (dir: -1 | 1) => {
    const i = SCENES.findIndex((s) => s.id === sceneId);
    const next = SCENES[(i + dir + SCENES.length) % SCENES.length];
    selectScene(next.id);
  };

  return (
    <div>
      <div className="font-jetbrains flex flex-wrap gap-2 text-[12px]">
        {SCENES.map((s) => (
          <button
            key={s.id}
            onClick={() => selectScene(s.id)}
            className={`rounded-full border px-3 py-1.5 transition ${
              s.id === sceneId
                ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                : "border-white/10 text-white/50 hover:text-white/80"
            }`}
          >
            sc {s.index}
            {!picks[s.id] && <span className="ml-1.5 text-amber-300/90">·</span>}
          </button>
        ))}
        <span className="ml-auto self-center text-[11px] text-white/35">
          {Object.values(picks).filter(Boolean).length} of {SCENES.length} picked
        </span>
      </div>

      <div className="mt-4 grid gap-5 lg:grid-cols-[1fr_260px]">
        <div>
          <div
            className={`relative aspect-video overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br ${frame.tone}`}
          >
            <button
              onClick={() => step(-1)}
              aria-label="Previous scene"
              className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full border border-white/15 bg-black/40 p-1.5 text-white/70 transition hover:text-white"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <button
              onClick={() => step(1)}
              aria-label="Next scene"
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full border border-white/15 bg-black/40 p-1.5 text-white/70 transition hover:text-white"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
            <p className="font-jetbrains absolute bottom-3 left-3 rounded bg-black/60 px-2 py-1 text-[11px] text-white/75">
              {scene.slug} · {frame.model}
            </p>
            {pick === frame.id && (
              <p className="font-jetbrains absolute top-3 left-3 rounded bg-cyan-300/90 px-2 py-0.5 text-[10px] font-semibold text-slate-950">
                PICKED
              </p>
            )}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            {scene.frames.map((f) => (
              <FrameThumb
                key={f.id}
                frame={f}
                picked={pick === f.id}
                className={`h-20 ${f.id === frame.id ? "ring-1 ring-cyan-300/50" : ""}`}
                onClick={() => setFrameId(f.id)}
              />
            ))}
          </div>
        </div>

        <aside className="space-y-4">
          <div>
            <p className="font-jetbrains mb-1.5 text-[11px] tracking-[0.14em] text-white/40 uppercase">prompt</p>
            <p className="font-jetbrains rounded-xl border border-white/8 bg-white/[0.03] p-3 text-[12px] leading-relaxed text-slate-300">
              {frame.prompt}
            </p>
          </div>
          <Control label="shot size" options={SHOT_SIZES} active={0} />
          <Control label="palette" options={PALETTES} active={scene.index === 5 ? 2 : 0} />
          <button
            onClick={() => setPicks((p) => ({ ...p, [scene.id]: frame.id }))}
            disabled={pick === frame.id}
            className="w-full rounded-xl bg-cyan-300/90 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:opacity-50"
          >
            {pick === frame.id ? "this is the pick" : "pick this frame"}
          </button>
          <button className="font-jetbrains w-full rounded-xl border border-white/12 py-2.5 text-[12px] text-white/70 transition hover:bg-white/5">
            generate 3 more
          </button>
          {frame.note && <p className="text-[13px] leading-snug text-slate-400">{frame.note}</p>}
        </aside>
      </div>
    </div>
  );
}

function Control({ label, options, active }: { label: string; options: string[]; active: number }) {
  return (
    <div>
      <p className="font-jetbrains mb-1.5 text-[11px] tracking-[0.14em] text-white/40 uppercase">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o, i) => (
          <span
            key={o}
            className={`font-jetbrains rounded-full border px-2.5 py-1 text-[11px] ${
              i === active ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/10 text-white/50"
            }`}
          >
            {o}
          </span>
        ))}
      </div>
    </div>
  );
}
