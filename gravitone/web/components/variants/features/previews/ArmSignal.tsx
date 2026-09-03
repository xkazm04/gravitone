"use client";

import { BENCHMARKS } from "@/lib/benchmarks";
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
 * arm · SIGNAL — time is the medium, and the picture is drawn to scale.
 *
 * The claim is a RATIO, so the only honest way to draw it is to spend the
 * canvas on it: one wall second is a fixed span at the top, and the audio that
 * second buys is the same span 4.26 times over, ticked second by second so the
 * eye can count it rather than take the number's word for it. Every figure comes
 * out of lib/benchmarks.ts — the same measured table the /benchmarks page reads
 * — and the geometry is COMPUTED from those figures, so a re-measured run moves
 * the drawing instead of leaving it quietly lying.
 *
 * Then the same scale carries the second finding. Four single-worker replicas —
 * processes, not threads, because the model is GIL-bound — each get a row, and
 * each row is drawn at the aggregate's share: 10.9 ÷ 4. Where a replica's row
 * stops is the measured truth; where it WOULD have stopped if throughput scaled
 * linearly is the dashed continuation, ending exactly under the single-stream
 * mark above it.
 *
 * That gap is the honest limit, and it is the reason this variant is built the
 * way it is. Four times a 4.26× stream is 17×; the measured aggregate is 10.9.
 * A diagram that drew four full-length rows would be a lie you could check with
 * a ruler, so this one draws the shortfall instead of omitting it.
 *
 * ONE ACCENT. Cyan is the measured audio and nothing else — the wall second,
 * the graticule, the brackets and the whole unmeasured continuation are hairline
 * white.
 */

const C8G = BENCHMARKS.find((b) => b.id === "c8g-2xlarge") ?? BENCHMARKS[0];
const RTF = C8G.singleStreamRtf; // audio-seconds per wall second, one stream
const PROCS = C8G.processes ?? 1;
const AGG = C8G.multiProcessAudPerS ?? RTF; // measured across those processes
const PER = AGG / PROCS; // each replica's share of the aggregate

const W = 640;
const H = 340;
const CYAN = accentVar("cyan");

/** User units per SECOND. The one constant the whole drawing is scaled by. */
const SEC = 108;
const X0 = 58;
const at = (seconds: number) => X0 + seconds * SEC;

const SOLO_Y = 120;
const ROW_Y = (i: number) => 196 + i * 26;

const SOLO = wavePath({
  w: at(RTF) - X0,
  h: 44,
  x: X0,
  y: SOLO_Y,
  amplitude: 0.86,
  frequency: RTF * 2.4,
  points: 160,
});

export default function ArmSignal({ still }: { still: boolean }) {
  return (
    <div>
      <Illus w={W} h={H} grid>
        <Label x={40} y={24} size={11} still={still}>
          {C8G.instance ?? C8G.platform}
        </Label>
        <Label x={600} y={24} anchor="end" size={10} still={still}>
          no gpu
        </Label>

        {/* The unit. Everything below is measured against this span. */}
        <Label x={X0} y={46} size={10} delay={0.1} still={still}>
          one wall second
        </Label>
        <Draw
          d={`M${X0} 58 V70 M${X0} 64 H${at(1)} M${at(1)} 58 V70`}
          delay={0.15}
          duration={0.3}
          stroke={HAIR}
          width={1.2}
          still={still}
        />

        {/* What one stream produces in it — the same span, 4.26 times over. */}
        <Draw d={SOLO} delay={0.4} duration={0.9} stroke={CYAN} width={1.7} still={still} />
        <TravelPulse d={SOLO} delay={0.45} duration={0.9} color={CYAN} size={4.5} still={still} />
        <Label x={at(RTF) + 10} y={SOLO_Y + 4} size={10} accent="cyan" delay={1.35} still={still}>
          {`${RTF}× realtime`}
        </Label>

        {/* The graticule that lets the ratio be counted rather than believed. */}
        {Array.from({ length: Math.floor(RTF) }, (_, i) => i + 1).map((s, i) => (
          <g key={s}>
            <Draw
              d={`M${at(s)} 146 V154`}
              delay={1.3 + i * 0.06}
              duration={0.15}
              stroke={HAIR}
              width={1}
              still={still}
            />
            <Label x={at(s)} y={168} anchor="middle" size={8} delay={1.45 + i * 0.06} still={still}>
              {`${s}s`}
            </Label>
          </g>
        ))}

        {/* The second finding: capacity comes from PROCESSES. */}
        <Label x={X0} y={182} size={9} delay={1.55} still={still}>
          {`${PROCS} single-worker replicas`}
        </Label>
        <Label x={600} y={182} anchor="end" size={11} accent="cyan" delay={2.5} still={still}>
          {`${AGG} aud/s`}
        </Label>
        {Array.from({ length: PROCS }, (_, i) => i).map((i) => (
          <g key={i}>
            <Label x={50} y={ROW_Y(i) + 3} anchor="end" size={8} delay={1.6 + i * 0.12} still={still}>
              {`r${i + 1}`}
            </Label>
            <Draw
              d={wavePath({
                w: at(PER) - X0,
                h: 20,
                x: X0,
                y: ROW_Y(i),
                amplitude: 0.85,
                frequency: PER * 3,
                phase: i * 1.3,
                points: 110,
              })}
              delay={1.6 + i * 0.12}
              duration={0.5}
              stroke={CYAN}
              width={1.4}
              still={still}
            />
            {/* Where linear scaling would have put it. It did not. */}
            <Draw
              d={`M${at(PER)} ${ROW_Y(i)} H${at(RTF)}`}
              delay={2.2 + i * 0.08}
              duration={0.4}
              stroke="rgba(255,255,255,0.5)"
              width={1.2}
              opacity={0.24}
              dashed
              still={still}
            />
          </g>
        ))}

        {/* The two spans on one baseline: what a replica delivers with three
            siblings beside it, and what it delivered alone. */}
        <Draw
          d={`M${X0} 288 V296 H${at(PER)} V288`}
          delay={2.6}
          duration={0.4}
          stroke={HAIR}
          width={1.2}
          still={still}
        />
        <Label x={(X0 + at(PER)) / 2} y={314} anchor="middle" size={10} accent="cyan" delay={2.7} still={still}>
          {`${Math.round(PER * 100) / 100}× each, measured`}
        </Label>
        <Draw
          d={`M${at(PER)} 288 V296 H${at(RTF)} V288`}
          delay={2.75}
          duration={0.4}
          stroke={HAIR}
          width={1.2}
          opacity={0.3}
          dashed
          still={still}
        />
        <Label
          x={(at(PER) + at(RTF)) / 2}
          y={314}
          anchor="middle"
          size={10}
          delay={2.85}
          still={still}
        >
          {`${RTF}× alone`}
        </Label>
      </Illus>

      <Caption delay={3.1} still={still}>
        {`${RTF}× realtime on one CPU stream, ${AGG} audio-seconds every second across ${PROCS} single-worker replicas — real scaling, not ${PROCS} times one stream, and reproducible on your own box.`}
      </Caption>
    </div>
  );
}
