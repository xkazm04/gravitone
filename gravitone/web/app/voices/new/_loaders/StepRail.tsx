"use client";

/*
 * THE STEP RAIL — the ingest pipeline's own steps, drawn.
 *
 * RESTRAINED TIER (web/DESIGN.md). This is a working tool, so the rail is a
 * Signal ACCENT on state, not an illustration: the pipeline is one line, each
 * step is a segment of it, and the only thing that carries colour is the step
 * that is running. Done steps settle to hairline, pending steps are the dashed
 * route not yet taken, and a single pulse travels the active segment when the
 * job enters it.
 *
 * SEMANTICS ARE UNTOUCHED. `steps` is the BACKEND's own list — its keys, its
 * labels, its states (service/ingest.py) — and nothing here invents, reorders,
 * renames or collapses one. The labels are rendered as TEXT under the drawing
 * (the SVG is aria-hidden by construction), so what a screen reader gets is the
 * same list, with each step's state named in words rather than in colour.
 *
 * MOTION. Entrance-only. Each segment's <Draw> is keyed on `${key}:${state}`,
 * so a step re-draws exactly once — at the moment it changes state — and then
 * holds. The travelling pulse is keyed on the active step's key, so it runs once
 * per step entered and never loops, however long that step takes. Stilled, the
 * pulse parks MID-segment: the end of an active step's story is "in this step",
 * and parking it at the far end would say "done" about work still running.
 */

import {
  Draw,
  HAIR,
  Illus,
  Node,
  TravelPulse,
  accentVar,
} from "@/components/variants/features/previews/illus";
import { useStillMotion } from "@/lib/useStillMotion";
import type { LoaderStep } from "./shared";

const W = 640;
const H = 30;
const Y = 15;
const X0 = 6;
const X1 = W - 6;
/** Gap between segments, in user units — a boundary the eye can see. */
const GAP = 7;
const CYAN = accentVar("cyan");

const STATE_WORD: Record<LoaderStep["state"], string> = {
  done: "done",
  active: "running",
  pending: "not started",
};

export default function StepRail({ steps }: { steps: LoaderStep[] }) {
  const still = useStillMotion();
  // Nothing measured yet is nothing to draw. An empty rail would claim a
  // pipeline shape the first poll has not described.
  if (steps.length === 0) return null;

  const span = (X1 - X0) / steps.length;
  const seg = (i: number) => {
    const a = X0 + i * span;
    return { a, b: a + span - GAP };
  };

  return (
    <div className="mt-4">
      <Illus w={W} h={H} className="block">
        {steps.map((s, i) => {
          const { a, b } = seg(i);
          const d = `M${a} ${Y} H${b}`;
          if (s.state === "active") {
            return (
              <g key={s.key}>
                <Draw
                  key={`${s.key}:active`}
                  d={d}
                  duration={0.7}
                  stroke={CYAN}
                  width={2}
                  still={still}
                />
                <Node x={a} y={Y} r={3} accent="cyan" still={still} />
                <TravelPulse
                  key={`pulse:${s.key}`}
                  d={d}
                  delay={0.15}
                  duration={1}
                  color={CYAN}
                  size={5}
                  restAt={0.5}
                  still={still}
                />
              </g>
            );
          }
          if (s.state === "done") {
            return (
              <g key={s.key}>
                <Draw
                  key={`${s.key}:done`}
                  d={d}
                  duration={0.45}
                  stroke={HAIR}
                  width={2}
                  still={still}
                />
                <Node x={a} y={Y} r={2.5} still={still} />
              </g>
            );
          }
          return (
            <Draw
              key={`${s.key}:pending`}
              d={d}
              duration={0.4}
              stroke={HAIR}
              width={2}
              opacity={0.5}
              dashed
              still={still}
            />
          );
        })}
      </Illus>

      {/* The honest list. The drawing above is aria-hidden, so this row is the
          step list — every backend label, with its state spelled out rather
          than encoded in a colour. */}
      <ol
        className="mt-1.5 grid gap-2"
        style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      >
        {steps.map((s) => (
          <li
            key={s.key}
            className={`font-jetbrains text-[10px] leading-snug ${
              s.state === "active"
                ? "text-cyan-300"
                : s.state === "done"
                  ? "text-white/45"
                  : "text-white/25"
            }`}
          >
            {s.label}
            <span className="sr-only"> — {STATE_WORD[s.state]}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
