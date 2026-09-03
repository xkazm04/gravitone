"use client";

import { Caption, Draw, HAIR, Illus, Label, Node, TravelPulse, WaveLine, accentVar } from "./illus";

/*
 * stream · SIGNAL — x is time, and the whole claim is an overlap.
 *
 * The top lane is the renderer. It is drawn as three separate utterances, each
 * pinched to the midline at both ends, because that is what a sentence is: the
 * boundaries are real, and they are the reason audio can leave early. The
 * moment a segment finishes drawing, a pulse drops off its end onto the lower
 * rail and that rail starts drawing — WHILE THE NEXT SEGMENT IS STILL BEING
 * DRAWN. That simultaneity is the feature; a diagram that finished rendering
 * before it started playing would be describing the endpoint this one replaces.
 *
 * The bottom lane is mp3, and it is one unbroken utterance across the same
 * width. Nothing departs from it until the very end, because mp3 cannot be
 * transcoded incrementally — the same work, the same finish time, and no early
 * exit. Two dashed verticals mark when each format's FIRST audio exists, and
 * the caliper between them is the honest limit drawn to scale rather than
 * footnoted.
 *
 * ONE ACCENT. Cyan is audio you can already hear. The mp3 lane, its late pulse
 * and its marker are hairline white, so the colour arriving early on one rail
 * and late on the other is the entire comparison.
 */

const W = 640;
const H = 350;
const CYAN = accentVar("cyan");

const LANE_Y = 92;
const HEAR_Y = 178;
const MP3_Y = 272;
const MP3_HEAR_Y = 312;

/* Three utterances end-to-end. `damp` defaults to 1, so each one is pinched to
 * the midline at both ends — the segment boundary is a silence, not a cut. */
const SENTENCES = [56, 224, 392].map((x, i) => ({
  x,
  end: x + 168,
  wave: { w: 168, h: 44, x, y: LANE_Y, amplitude: 0.85, frequency: 3, phase: i * 1.9, points: 64 },
}));

/** Off the end of a finished sentence, down onto the rail you hear. */
const drop = (x: number, from: number, to: number) =>
  `M${x} ${from} C${x} ${from + 34} ${x + 8} ${to - 34} ${x + 8} ${to}`;

const MP3 = {
  w: 504,
  h: 44,
  x: 56,
  y: MP3_Y,
  amplitude: 0.85,
  frequency: 9,
  points: 160,
} as const;

export default function StreamSignal({ still }: { still: boolean }) {
  return (
    <div>
      <Illus w={W} h={H} grid>
        {/* The caliper between the two first-audio moments. Drawn last, because
            it is the conclusion the two rails have already made. */}
        <Draw d="M232 40 H568" delay={2.85} duration={0.5} stroke={HAIR} width={1} still={still} />
        <Draw d="M232 34 V46 M568 34 V46" delay={3.05} duration={0.2} stroke={HAIR} width={1} still={still} />
        <Label x={400} y={28} anchor="middle" size={10} delay={3.1} still={still}>
          the whole render
        </Label>

        {/* When each format's first audio exists. */}
        <Draw d="M232 48 V214" delay={1.2} duration={0.45} stroke={CYAN} width={1.2} dashed still={still} />
        <Draw d="M568 48 V330" delay={2.7} duration={0.5} stroke={HAIR} width={1.2} dashed still={still} />

        <Label x={56} y={66} size={11} accent="cyan" still={still}>
          pcm / wav
        </Label>

        {SENTENCES.map((s, i) => {
          const start = 0.35 + i * 0.75;
          return (
            <g key={s.x}>
              {/* Rendering. */}
              <WaveLine wave={s.wave} delay={start} duration={0.75} stroke={CYAN} width={1.6} still={still} />
              <Label x={s.x + 84} y={LANE_Y + 44} anchor="middle" size={9} delay={start + 0.2} still={still}>
                {`sentence ${i + 1}`}
              </Label>
              {/* Leaving, the instant it is finished. */}
              <Draw
                d={drop(s.end, LANE_Y, HEAR_Y)}
                delay={start + 0.75}
                duration={0.4}
                stroke={HAIR}
                width={1}
                still={still}
              />
              <TravelPulse
                d={drop(s.end, LANE_Y, HEAR_Y)}
                delay={start + 0.75}
                duration={0.55}
                color={CYAN}
                size={4.5}
                still={still}
              />
              {/* Playing — while the segment above is still being drawn. */}
              <Draw
                d={`M${s.end + 8} ${HEAR_Y} H${Math.min(604, s.end + 176)}`}
                delay={start + 1}
                duration={0.7}
                stroke={CYAN}
                width={2.2}
                still={still}
              />
            </g>
          );
        })}

        <Node x={232} y={HEAR_Y} r={4} accent="cyan" delay={1.6} still={still} />
        <Label x={222} y={HEAR_Y + 4} anchor="end" size={10} accent="cyan" delay={1.65} still={still}>
          you hear
        </Label>

        {/* The other format: same work, same finish, no early exit. */}
        <Label x={56} y={246} size={11} still={still}>
          mp3 · one body
        </Label>
        <WaveLine wave={MP3} delay={0.5} duration={2.1} stroke="rgba(255,255,255,0.5)" width={1.6} still={still} />
        <Draw
          d={drop(560, MP3_Y, MP3_HEAR_Y)}
          delay={2.6}
          duration={0.3}
          stroke={HAIR}
          width={1}
          still={still}
        />
        <TravelPulse
          d={drop(560, MP3_Y, MP3_HEAR_Y)}
          delay={2.62}
          duration={0.45}
          color="rgba(255,255,255,0.8)"
          size={4}
          still={still}
        />
        <Draw
          d={`M568 ${MP3_HEAR_Y} H604`}
          delay={2.85}
          duration={0.35}
          stroke="rgba(255,255,255,0.6)"
          width={2.2}
          still={still}
        />
        <Label x={300} y={306} anchor="middle" size={9} delay={2.9} still={still}>
          x-stream-fallback
        </Label>
      </Illus>

      <Caption delay={3.2} still={still}>
        The first sentence is already playing while the rest render — and mp3,
        which cannot be transcoded incrementally, comes back whole and says so in
        a header instead of looking slow.
      </Caption>
    </div>
  );
}
