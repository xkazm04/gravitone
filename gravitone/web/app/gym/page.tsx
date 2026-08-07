"use client";

// The Conversation Gym — a recorded call, replayed as a deterministic test.
//
// PROTOTYPE HARNESS (throwaway): three directional variants behind a tab
// switcher, per /prototype. The switcher does not survive consolidation — the
// winning variant becomes the sole render and the others are deleted.

import { useEffect, useState } from "react";

import AppFrame from "@/components/ui/AppFrame";
import { Eyebrow } from "@/components/ui/Primitives";

import GymBench from "./_variants/GymBench";
import GymLadder from "./_variants/GymLadder";
import GymSession from "./_variants/GymSession";

const VARIANTS = [
  { id: "bench", label: "Bench", sub: "the certification instrument" },
  { id: "session", label: "Session", sub: "the conversation relived" },
  { id: "ladder", label: "Ladder", sub: "level by level" },
] as const;

type VariantId = (typeof VARIANTS)[number]["id"];
const STORAGE_KEY = "proto-gym";

export default function GymPage() {
  const [variant, setVariant] = useState<VariantId>("bench");

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && VARIANTS.some((v) => v.id === saved)) setVariant(saved as VariantId);
  }, []);

  const pick = (id: VariantId) => {
    setVariant(id);
    window.localStorage.setItem(STORAGE_KEY, id);
  };

  return (
    <AppFrame>
      <main className="pb-20">
        <header className="pt-6">
          <Eyebrow>conversation gym</Eyebrow>
          <h1 className="font-instrument mt-4 text-4xl text-white">
            Replay a call. Hold the agent to it.
          </h1>
          <p className="font-hanken mt-2 max-w-2xl text-base text-slate-400">
            A recorded conversation streamed back through the socket, frame by frame, against the
            same agent — the numbers it produced once, produced again, and therefore comparable.
          </p>
        </header>

        {/* prototype switcher — removed at consolidation */}
        <div className="mt-8 flex gap-2">
          {VARIANTS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => pick(v.id)}
              className={`rounded-full border px-4 py-1.5 text-left transition ${
                variant === v.id
                  ? "border-cyan-400/40 bg-cyan-400/10"
                  : "border-white/10 hover:border-white/25"
              }`}
            >
              <span
                className={`font-jetbrains block text-[12px] ${
                  variant === v.id ? "text-cyan-200" : "text-white/80"
                }`}
              >
                {v.label}
              </span>
              <span className="font-hanken block text-[11px] text-white/40">{v.sub}</span>
            </button>
          ))}
        </div>

        <div className="mt-8">
          {variant === "bench" && <GymBench />}
          {variant === "session" && <GymSession />}
          {variant === "ladder" && <GymLadder />}
        </div>
      </main>
    </AppFrame>
  );
}
