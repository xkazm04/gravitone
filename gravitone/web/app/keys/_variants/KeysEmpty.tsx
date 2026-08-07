"use client";

/*
 * NO KEYS YET, TAUGHT.
 *
 * The one empty body on this page that is a FACT about the account rather than
 * a failure — the ledger loaded, and it is empty — so it is allowed to teach
 * (DESIGN.md: empty states that teach take the full tier). What it teaches is
 * the mechanism the page exists for: a caller's request travels a path, meets
 * this deployment's boundary, and what decides whether it crosses is a key.
 *
 * IT IS DRAWN FROM THE MEASUREMENT, NOT FROM THE IDEA. The obvious picture —
 * keyed request through, unkeyed request turned back — is a CLAIM about this
 * box, and `PostureNote` right above it may have just measured the opposite.
 * So the second lane is the probe's own verdict:
 *
 *   enforced    turned back at the line. Only TTS_API_KEY does that.
 *   open        straight through, alongside the keyed one — the same thing the
 *               rose banner says in words: these keys enforce nothing.
 *   unmeasured  stops AT the line, unresolved. Absence, not reassurance.
 *   unreachable  ditto — nothing answered, so no verdict is drawn.
 *
 * ONE ACCENT: cyan is the keyed request and nothing else. A refusal is hairline
 * because the boundary working is not an error.
 *
 * The caption is the ledger's own sentence, passed in; nothing here writes copy.
 */

import {
  Caption,
  Draw,
  HAIR,
  Illus,
  Label,
  Node,
  TravelPulse,
  accentVar,
} from "@/components/variants/features/previews/illus";
import { useStillMotion } from "@/lib/useStillMotion";
import type { ReactNode } from "react";
import type { Posture } from "./probes";

const W = 460;
const H = 112;
const CYAN = accentVar("cyan");

/** The boundary — this deployment's edge, where a key is or is not required. */
const GATE_X = 264;
const KEYED = `M40 44 H${GATE_X - 8} M${GATE_X + 8} 44 H414`;
/** The pulse rides the whole span; the gap above is the gate, not a break. */
const KEYED_RIDE = "M40 44 H414";
/** Unkeyed, refused: same start, turned back at the same line. */
const REFUSED = `M40 84 H${GATE_X - 8} C${GATE_X - 2} 84 ${GATE_X - 2} 96 ${GATE_X - 14} 96 H70`;
/** Unkeyed, served anyway: the boundary is not acting. */
const UNGATED = `M40 84 H414`;
/** Unkeyed, unmeasured: it reaches the line and the drawing stops there. */
const UNRESOLVED = `M40 84 H${GATE_X - 8}`;

export default function KeysEmpty({
  posture,
  children,
}: {
  posture: Posture;
  children: ReactNode;
}) {
  const still = useStillMotion();
  const second =
    posture === "enforced"
      ? { d: REFUSED, dashed: false, label: "refused" as string | null }
      : posture === "open"
        ? { d: UNGATED, dashed: true, label: "served too" }
        : { d: UNRESOLVED, dashed: true, label: null };

  return (
    <div className="mx-auto max-w-md">
      <Illus w={W} h={H}>
        {/* The boundary, drawn first: everything else is defined by which side
            of it a request ends up on. */}
        <Draw d={`M${GATE_X} 18 V104`} duration={0.5} stroke={HAIR} width={1.4} still={still} />
        <Label x={GATE_X + 8} y={16} size={8} delay={0.4} still={still}>
          this deployment
        </Label>

        {/* Carrying a key. */}
        <Draw d={KEYED} delay={0.35} duration={0.8} stroke={CYAN} width={1.8} still={still} />
        <Node x={GATE_X} y={44} r={3.5} accent="cyan" delay={0.8} still={still} />
        <TravelPulse d={KEYED_RIDE} delay={0.5} duration={1.1} color={CYAN} size={4.5} still={still} />
        <Label x={40} y={34} size={8} accent="cyan" delay={0.9} still={still}>
          with a key
        </Label>
        <Label x={414} y={34} anchor="end" size={8} accent="cyan" delay={1.4} still={still}>
          served
        </Label>

        {/* Carrying none — whatever the probe actually found. */}
        <Draw
          d={second.d}
          delay={1.1}
          duration={0.7}
          stroke={HAIR}
          width={1.4}
          dashed={second.dashed}
          still={still}
        />
        <Label x={40} y={74} size={8} delay={1.2} still={still}>
          without one
        </Label>
        {second.label && (
          <Label
            x={posture === "open" ? 414 : 74}
            y={posture === "open" ? 74 : 110}
            anchor={posture === "open" ? "end" : "start"}
            size={8}
            delay={1.6}
            still={still}
          >
            {second.label}
          </Label>
        )}
      </Illus>
      <Caption delay={1.9} still={still}>
        {children}
      </Caption>
    </div>
  );
}
