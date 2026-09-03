"use client";

/*
 * THE EMPTY ROSTER, TAUGHT.
 *
 * An empty state is one of the places DESIGN.md says Signal applies in full: it
 * has no data to compete with, and the visitor's actual question is "what would
 * be here?". The drawing answers it in the product's own physics — a recording
 * is a wave, and a Character is that wave fanned out across an emotion scale
 * where only the recorded slots exist and the rest fall back to the one that
 * does.
 *
 * ONE ACCENT: cyan is the baseline Voice — the slot every Character has and the
 * one every missing emotion resolves to. The unrecorded slots are the hairline
 * dashed route, which is exactly what they are in `CoverageBar` above.
 *
 * The caption is the roster's OWN copy, passed in — this component invents no
 * prose, so the empty-state sentence stays in one place and keeps its meaning.
 */

import {
  Caption,
  Draw,
  HAIR,
  Illus,
  Label,
  Node,
  WaveLine,
  accentVar,
} from "@/components/variants/features/previews/illus";
import { useStillMotion } from "@/lib/useStillMotion";
import type { ReactNode } from "react";

const W = 460;
const H = 110;
const CYAN = accentVar("cyan");

/** The emotion scale, as rows. Row 0 is baseline — the only recorded one. */
const ROWS = 5;
const ROW_Y = (i: number) => 22 + i * 17;
const SLOT_X0 = 268;
const SLOT_X1 = 392;

export default function RosterEmpty({ children }: { children: ReactNode }) {
  const still = useStillMotion();
  return (
    <div className="mx-auto max-w-md">
      <Illus w={W} h={H}>
        <Label x={16} y={16} size={9} still={still}>
          one recording
        </Label>
        <WaveLine
          wave={{ w: 180, h: 56, x: 16, y: 62, amplitude: 0.85, frequency: 4, points: 120 }}
          duration={0.9}
          stroke={HAIR}
          width={1.6}
          still={still}
        />

        {/* The fan: one recording becomes a Character with a scale of slots. */}
        <Node x={206} y={62} r={3} accent="cyan" delay={0.9} still={still} />
        <Label x={268} y={13} size={9} still={still}>
          emotion slots
        </Label>
        {Array.from({ length: ROWS }, (_, i) => i).map((i) => (
          <Draw
            key={`fan-${i}`}
            d={`M206 62 C232 62 240 ${ROW_Y(i)} ${SLOT_X0 - 6} ${ROW_Y(i)}`}
            delay={1 + i * 0.06}
            duration={0.45}
            stroke={HAIR}
            width={1}
            opacity={0.6}
            still={still}
          />
        ))}

        {/* Slot 0 is recorded (accent, solid); the rest are the dashed fallback
            — the same grammar the coverage pips use for a missing emotion. */}
        <Draw
          d={`M${SLOT_X0} ${ROW_Y(0)} H${SLOT_X1}`}
          delay={1.35}
          duration={0.5}
          stroke={CYAN}
          width={2}
          still={still}
        />
        {Array.from({ length: ROWS - 1 }, (_, i) => i + 1).map((i) => (
          <Draw
            key={`slot-${i}`}
            d={`M${SLOT_X0} ${ROW_Y(i)} H${SLOT_X1}`}
            delay={1.4 + i * 0.07}
            duration={0.4}
            stroke={HAIR}
            width={2}
            opacity={0.55}
            dashed
            still={still}
          />
        ))}
        <Label x={SLOT_X1 + 6} y={ROW_Y(0) + 3} size={8} accent="cyan" delay={1.8} still={still}>
          baseline
        </Label>
      </Illus>
      <Caption delay={2} still={still}>
        {children}
      </Caption>
    </div>
  );
}
