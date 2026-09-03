"use client";

import { motion } from "framer-motion";
import {
  Caption,
  Draw,
  HAIR,
  Illus,
  Label,
  Node,
  TravelPulse,
  accentVar,
  wavePath,
} from "./illus";

/*
 * performance · SIGNAL — three voices, one line of audio, one report back.
 *
 * The claim is that a whole script goes out in ONE call and comes back as one
 * rendered performance, so the drawing is built around a single unbroken output
 * path. The three script lines are drawn as a STAIRCASE above it — each line
 * sitting directly over the stretch of the tape it becomes — and each one drops
 * straight down into its own place in that tape. Nothing crosses, so the reading
 * order of the script and the time order of the audio are the same order, which
 * is the part an API diagram of three separate requests could never show.
 *
 * The output really is one path: three wavePaths concatenated, the joins made at
 * the midline because a damped utterance begins and ends at silence. That is not
 * a trick — it is the same reason the segments can be spliced server-side.
 *
 * ONE ACCENT. Violet is the rendered performance and nothing else. The script
 * traces, the drops and the report rail are all hairline white, so the single
 * coloured object on screen is the single thing the call returns.
 *
 * The honest limit is drawn where it happened, not footnoted. `[flat]` is struck
 * through IN THE SCRIPT — the tag the caller wrote, still visible, with the
 * substitution named beside it — and the third report tick comes back dashed and
 * says `baseline`. An emotion this rack does not hold is not an error and is not
 * silent; it is a line in X-Performance-Report, so it is a line in the picture.
 */

const W = 640;
const H = 340;
const VIOLET = accentVar("violet");

/** Each line: where it sits in the script, and the voice signature it renders
 *  with. The SAME frequency/phase is used for the script trace and its stretch
 *  of the output, because it is the same voice in both places. */
const LINES = [
  { who: "marcus", tag: "[weary]", f: 2.2, p: 0, amp: 0.86 },
  { who: "sarah", tag: "[excited]", f: 4.1, p: 1.3, amp: 0.62 },
  { who: "ines", tag: "[flat]", f: 2.9, p: 2.6, amp: 0.95 },
];

const X0 = 60; // left edge of line 0 — and of the tape
const STEP = 180; // one line of script, one stretch of tape
const TAPE_Y = 250;

/** Monospace advance at size 10 with the 0.14em tracking <Label> sets. */
const adv = (s: string) => s.length * 7.4;

const lineX = (i: number) => X0 + i * STEP;
const lineY = (i: number) => 62 + i * 40;

/* One path, three signatures. Each segment is damped, so it starts and ends on
 * the midline and the next one can continue from exactly there — the `M` of
 * every segment after the first becomes an `L` and the whole performance is a
 * single `d`, drawn in a single stroke. */
const TAPE = LINES.map((l, i) =>
  wavePath({
    w: STEP,
    h: 46,
    x: lineX(i),
    y: TAPE_Y,
    amplitude: l.amp,
    frequency: l.f,
    phase: l.p,
    points: 72,
  }),
)
  .map((d, i) => (i === 0 ? d : d.replace("M", "L")))
  .join(" ");

const RAIL = "M600 300 H52";
const ARROW = "M62 294 L52 300 L62 306";

export default function PerformanceSignal({ still }: { still: boolean }) {
  const last = LINES.length - 1;
  return (
    <div>
      <Illus w={W} h={H} grid>
        <Label x={40} y={24} size={11} still={still}>
          post /v1/performance
        </Label>
        {/* The brace: everything above the tape left in ONE request. */}
        <Draw d="M50 42 H42 V162 H50" delay={0.1} duration={0.35} stroke={HAIR} width={1} still={still} />
        <Label x={42} y={180} size={9} delay={0.2} still={still}>
          one call
        </Label>

        {LINES.map((l, i) => {
          const x = lineX(i);
          const y = lineY(i);
          return (
            <g key={l.who}>
              <Label x={x} y={y - 26} size={10} delay={0.2 + i * 0.25} still={still}>
                {l.who}
              </Label>
              <Label
                x={x + adv(l.who) + 8}
                y={y - 26}
                size={10}
                delay={0.25 + i * 0.25}
                still={still}
              >
                {l.tag}
              </Label>
              {/* The script line, in that character's voice. */}
              <Draw
                d={wavePath({
                  w: 150,
                  h: 36,
                  x,
                  y,
                  amplitude: l.amp,
                  frequency: l.f,
                  phase: l.p,
                  points: 72,
                })}
                delay={0.15 + i * 0.25}
                duration={0.6}
                stroke="rgba(255,255,255,0.5)"
                width={1.4}
                still={still}
              />
              {/* …dropping into its own stretch of the one output. */}
              <Draw
                d={`M${x} ${y} V${TAPE_Y - 24}`}
                delay={0.55 + i * 0.25}
                duration={0.3}
                stroke={HAIR}
                width={1}
                still={still}
              />
              <Node x={x} y={TAPE_Y} r={3} accent="violet" delay={1.35 + i * 0.16} still={still} />
            </g>
          );
        })}

        {/* The performance: one stroke, three voices inside it. */}
        <Draw d={TAPE} delay={1.3} duration={1} stroke={VIOLET} width={1.7} still={still} />
        <TravelPulse d={TAPE} delay={1.35} duration={1} color={VIOLET} size={4.5} still={still} />

        {/* The emotion the rack did not have — struck where it was asked for. */}
        <motion.g
          initial={still ? { opacity: 1 } : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={still ? undefined : { delay: 2.35, duration: 0.25 }}
        >
          <path
            d={`M${lineX(last) + adv(LINES[last].who) + 6} ${lineY(last) - 30} H${
              lineX(last) + adv(LINES[last].who) + 12 + adv(LINES[last].tag)
            }`}
            stroke="rgba(255,255,255,0.5)"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
        </motion.g>
        <Label
          x={lineX(last) + adv(LINES[last].who) + adv(LINES[last].tag) + 20}
          y={lineY(last) - 26}
          size={9}
          accent="violet"
          delay={2.45}
          still={still}
        >
          baseline
        </Label>

        {/* What the call reports back, per line, on the way out. */}
        <Draw d={RAIL} delay={2.5} duration={0.5} stroke={HAIR} width={1.2} still={still} />
        <Draw d={ARROW} delay={2.95} duration={0.2} stroke={HAIR} width={1.4} still={still} />
        <Label x={66} y={292} size={9} delay={2.6} still={still}>
          x-performance-report
        </Label>
        {LINES.map((l, i) => {
          const mid = lineX(i) + STEP / 2;
          const fell = i === last;
          return (
            <g key={`tick-${l.who}`}>
              <Draw
                d={`M${mid} 276 V300`}
                delay={2.6 + i * 0.1}
                duration={0.25}
                stroke={HAIR}
                width={1}
                dashed={fell}
                still={still}
              />
              <Label
                x={mid}
                y={318}
                anchor="middle"
                size={9}
                delay={2.8 + i * 0.1}
                still={still}
              >
                {fell ? "baseline" : "rendered"}
              </Label>
            </g>
          );
        })}
        <TravelPulse
          d={RAIL}
          delay={2.7}
          duration={0.6}
          color="rgba(255,255,255,0.75)"
          size={4}
          still={still}
        />
      </Illus>

      <Caption delay={3.1} still={still}>
        One POST, one rendered performance — and the report riding back names what
        every line actually became, including the emotion this rack did not hold.
      </Caption>
    </div>
  );
}
