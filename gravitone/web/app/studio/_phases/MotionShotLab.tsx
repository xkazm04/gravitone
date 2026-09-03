"use client";

// MOTION / SHOT LAB — the winner. One shot on the bench, the causal chain
// drawn left to right: source frame → motion direction → what came back.
// Polish round: the chain has visible arrows, VFX layers actually arm and
// disarm, and the bench opens on whichever scene needs attention most.

import { useState } from "react";
import { ArrowRight } from "lucide-react";

import { SCENES } from "../_studio/scenes";
import { ClipStatusWord, FrameThumb } from "../_studio/projectParts";

export default function MotionShotLab() {
  const [sceneId, setSceneId] = useState("sc-3"); // open on the rejected one
  const scene = SCENES.find((s) => s.id === sceneId) ?? SCENES[0];
  const picked = scene.frames.find((f) => f.id === scene.pickedFrameId);
  const [armed, setArmed] = useState<Record<string, boolean>>({});
  const isArmed = (v: string) => armed[`${scene.id}:${v}`] ?? true;
  const toggle = (v: string) =>
    setArmed((m) => ({ ...m, [`${scene.id}:${v}`]: !isArmed(v) }));

  return (
    <div>
      <div className="font-jetbrains flex flex-wrap gap-2 text-[12px]">
        {SCENES.map((s) => (
          <button
            key={s.id}
            onClick={() => setSceneId(s.id)}
            className={`rounded-full border px-3 py-1.5 transition ${
              s.id === sceneId
                ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
                : "border-white/10 text-white/50 hover:text-white/80"
            }`}
          >
            sc {s.index}
            {s.clip?.status === "failed" && <span className="ml-1.5 text-rose-300">·</span>}
            {!s.pickedFrameId && <span className="ml-1.5 text-amber-300/90">·</span>}
          </button>
        ))}
      </div>

      <div className="mt-4 grid items-stretch gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
        {/* source */}
        <section className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
          <p className="font-jetbrains text-[11px] tracking-[0.14em] text-white/40 uppercase">source frame</p>
          {picked ? (
            <>
              <FrameThumb frame={picked} className="mt-3 h-36" />
              <p className="font-jetbrains mt-2 text-[11px] text-slate-500">“{picked.prompt}”</p>
            </>
          ) : (
            <p className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-sm text-amber-200/90">
              No frame picked — the bench is empty until Frames decides.
            </p>
          )}
        </section>

        <Chain />

        {/* direction */}
        <section className="rounded-2xl border border-white/8 bg-white/[0.02] p-4">
          <p className="font-jetbrains text-[11px] tracking-[0.14em] text-white/40 uppercase">motion direction</p>
          <p className="font-jetbrains mt-3 min-h-20 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[12px] leading-relaxed text-slate-300">
            {scene.clip?.motionPrompt ?? "—"}
          </p>
          <p className="font-jetbrains mt-2 text-[11px] text-white/40">slot: {scene.targetS}s</p>
          <div className="mt-3 space-y-1.5">
            {scene.vfx.map((v) => (
              <button
                key={v}
                onClick={() => toggle(v)}
                className="flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left text-[13px] text-slate-300 transition hover:bg-white/[0.04]"
              >
                <span
                  className={`grid h-4 w-4 place-items-center rounded border text-[10px] transition ${
                    isArmed(v)
                      ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-300"
                      : "border-white/15 text-transparent"
                  }`}
                >
                  ✓
                </span>
                <span className={isArmed(v) ? "" : "text-slate-500 line-through"}>{v}</span>
              </button>
            ))}
            {scene.vfx.length === 0 && <p className="text-[13px] text-slate-500">no vfx layers armed</p>}
          </div>
        </section>

        <Chain />

        {/* result */}
        <section
          className={`rounded-2xl border p-4 ${
            scene.clip?.status === "failed"
              ? "border-rose-400/25 bg-rose-400/[0.03]"
              : "border-white/8 bg-white/[0.02]"
          }`}
        >
          <p className="font-jetbrains flex items-center justify-between text-[11px] tracking-[0.14em] text-white/40 uppercase">
            result {scene.clip && <ClipStatusWord status={scene.clip.status} />}
          </p>
          {scene.clip ? (
            <>
              <div
                className={`mt-3 grid aspect-video place-items-center rounded-xl border ${
                  scene.clip.status === "rendered"
                    ? `border-white/10 bg-gradient-to-br ${picked?.tone ?? ""}`
                    : "border-dashed border-white/15"
                }`}
              >
                {scene.clip.status !== "rendered" && (
                  <span className="font-jetbrains text-[11px] text-white/40">
                    {scene.clip.status === "rendering" ? "render in flight" : "no accepted take"}
                  </span>
                )}
              </div>
              <p
                className={`mt-2 text-sm leading-snug ${
                  scene.clip.status === "failed" ? "text-rose-200/90" : "text-slate-400"
                }`}
              >
                {scene.clip.note}
              </p>
              {scene.clip.status === "failed" && (
                <button className="mt-3 rounded-full bg-cyan-300/90 px-4 py-1.5 text-[13px] font-semibold text-slate-950 transition hover:brightness-110">
                  retry with tighter orbit
                </button>
              )}
            </>
          ) : (
            <p className="mt-3 text-sm text-slate-500">Nothing has been asked of the model yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}

/** The bench's causal arrow — hidden on stacked layouts where the flow
 *  reads top-to-bottom anyway. */
function Chain() {
  return (
    <span className="hidden items-center lg:flex" aria-hidden>
      <ArrowRight className="h-4 w-4 text-white/25" />
    </span>
  );
}
