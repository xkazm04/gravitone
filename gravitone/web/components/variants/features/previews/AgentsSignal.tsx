"use client";

import {
  Caption,
  Draw,
  HAIR,
  Illus,
  Label,
  TravelPulse,
  accentVar,
  wavePath,
} from "./illus";

/*
 * agents · SIGNAL — one channel, both directions, and the cut.
 *
 * X is time and the horizontal rail is the socket: ONE connection, with the
 * caller's speech deflecting above it and the agent's below. Two tracks on one
 * line is the whole of "duplex" — a diagram with two rails would be drawing two
 * requests, which is exactly the thing a conversation API is not.
 *
 * The turn boundaries are marked where the silence is, because that is where
 * local VAD puts them. Two of the three boundaries in this exchange are silences
 * and get a dashed tick. The third is not a silence, and that is the drawing.
 *
 * THE CUT IS THE POINT, so it is drawn as a cut. The agent's utterance is one
 * path, planned to its full length; the spoken part is clipped at the instant
 * the caller's onset reaches the rail, so the stroke is severed mid-deflection
 * rather than politely damped to silence. What was left of the sentence stays on
 * screen as a dashed ghost under a bracket — an agent that is interrupted has
 * something it did not get to say, and hiding that would flatter the mechanism.
 *
 * ONE ACCENT. Cyan is the interruption and nothing else: the caller's onset, the
 * hook down to the rail, and the cut itself. Every other utterance in the frame
 * is hairline white, so the single coloured event on screen is the single moment
 * a duplex socket has to get right.
 */

const W = 640;
const H = 330;
const CYAN = accentVar("cyan");

const AXIS_Y = 160;
const CALLER_Y = 112;
const AGENT_Y = 210;

/** The agent's sentence, planned in full. It is drawn once solid (clipped at
 *  the cut) and once dashed (the whole thing) — same `d`, so the ghost lines up
 *  with the spoken part exactly. */
const AGENT_PLANNED = wavePath({
  w: 228,
  h: 64,
  x: 258,
  y: AGENT_Y,
  amplitude: 0.78,
  frequency: 5.4,
  points: 120,
});
const CUT_X = 396;

const CALLER_1 = wavePath({ w: 150, h: 64, x: 90, y: CALLER_Y, amplitude: 0.8, frequency: 4.2, points: 96 });
const CALLER_2 = wavePath({
  w: 86,
  h: 64,
  x: 384,
  y: CALLER_Y,
  amplitude: 0.94,
  frequency: 6.4,
  phase: 0.6,
  points: 96,
});
const AGENT_2 = wavePath({
  w: 98,
  h: 64,
  x: 506,
  y: AGENT_Y,
  amplitude: 0.72,
  frequency: 4.8,
  phase: 1.9,
  points: 96,
});

/** Caller onset → rail. The interrupt is a thing that TRAVELS; drawing it as a
 *  connector is what makes the cut a consequence rather than a coincidence. */
const HOOK = `M384 ${CALLER_Y} C384 140 ${CUT_X} 146 ${CUT_X} 174`;

export default function AgentsSignal({ still }: { still: boolean }) {
  return (
    <div>
      <Illus w={W} h={H} grid>
        <defs>
          {/* Everything of the agent's sentence that was actually spoken. */}
          <clipPath id="gt-agents-spoken">
            <rect x={250} y={170} width={CUT_X - 250} height={84} />
          </clipPath>
        </defs>

        <Label x={40} y={24} size={11} still={still}>
          one socket, duplex
        </Label>

        {/* The connection itself. */}
        <Draw d={`M40 ${AXIS_Y} H608`} delay={0.1} duration={0.5} stroke={HAIR} width={1.2} still={still} />
        <Label x={82} y={CALLER_Y} anchor="end" size={10} delay={0.2} still={still}>
          caller
        </Label>
        <Label x={82} y={AGENT_Y} anchor="end" size={10} delay={0.25} still={still}>
          agent
        </Label>

        {/* Turn one. */}
        <Draw d={CALLER_1} delay={0.25} duration={0.7} stroke="rgba(255,255,255,0.55)" width={1.6} still={still} />
        <Draw d={`M249 148 V172`} delay={0.95} duration={0.2} stroke={HAIR} width={1} dashed still={still} />
        <Label x={249} y={142} anchor="middle" size={8} delay={1} still={still}>
          vad
        </Label>

        {/* The agent answering — severed at the cut, not faded out of it. */}
        <g clipPath="url(#gt-agents-spoken)">
          <Draw
            d={AGENT_PLANNED}
            delay={1.05}
            duration={1.05}
            stroke="rgba(255,255,255,0.55)"
            width={1.6}
            still={still}
          />
        </g>

        {/* The caller coming in over the top of it. */}
        <Label x={380} y={74} size={10} accent="cyan" delay={1.45} still={still}>
          cuts in
        </Label>
        <Draw d={CALLER_2} delay={1.5} duration={0.55} stroke={CYAN} width={1.8} still={still} />
        <Draw d={HOOK} delay={1.55} duration={0.2} stroke={CYAN} width={1.2} still={still} />
        <TravelPulse d={HOOK} delay={1.6} duration={0.4} color={CYAN} size={4} still={still} />
        <Draw d={`M${CUT_X} 174 V246`} delay={1.7} duration={0.15} stroke={CYAN} width={2} still={still} />
        <Label x={CUT_X - 4} y={268} anchor="end" size={10} accent="cyan" delay={1.85} still={still}>
          barge-in
        </Label>

        {/* What the agent did not get to say. */}
        <Draw d={AGENT_PLANNED} delay={1.85} duration={0.4} stroke="rgba(255,255,255,0.5)" width={1.4} opacity={0.26} dashed still={still} />
        <Draw d="M398 250 V256 H484 V250" delay={2} duration={0.3} stroke={HAIR} width={1} still={still} />
        <Label x={441} y={272} anchor="middle" size={9} delay={2.1} still={still}>
          unspoken
        </Label>

        {/* And it takes the turn back. */}
        <Draw d={`M496 148 V172`} delay={2.15} duration={0.2} stroke={HAIR} width={1} dashed still={still} />
        <Label x={496} y={142} anchor="middle" size={8} delay={2.2} still={still}>
          vad
        </Label>
        <Draw d={AGENT_2} delay={2.25} duration={0.7} stroke="rgba(255,255,255,0.55)" width={1.6} still={still} />
      </Illus>

      <Caption delay={3.1} still={still}>
        Both directions on one socket — and when you talk over the agent it stops
        mid-word, because the VAD that found that edge is running on your box, not
        somebody's meter.
      </Caption>
    </div>
  );
}
