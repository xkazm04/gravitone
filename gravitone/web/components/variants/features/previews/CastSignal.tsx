"use client";

import { motion } from "framer-motion";
import { Caption, Draw, HAIR, Illus, Label, Node, WaveLine, accentVar, type Accent } from "./illus";

/*
 * cast · SIGNAL — one utterance, and the voices that were always inside it.
 *
 * The whole claim is a split, so the drawing is a split and nothing else. One
 * waveform draws itself across the top. Then each speaker's share LIGHTS UP
 * along that same line in its own colour and peels down into a lane of its own,
 * contracting as it goes. Nothing is added to the picture at the split — which
 * is the point. The cast was already in the recording; the scan is what
 * separated it.
 *
 * COLOUR IS IDENTITY HERE, and that is the one deliberate departure from the
 * "one accent" rule the signal direction otherwise keeps: three ribbons that
 * cannot be told apart would be a diagram of blending, the exact thing this
 * feature is not. Everything else in the frame stays hairline white so the trio
 * is the only colour on screen and reads as "three of something".
 *
 * The source wave dims but stays. A source that vanished would say the analysis
 * was spent; it wasn't — it is ONE paid analysis and every speaker in it stays
 * castable, which is the caption's job to name and the picture's job to show by
 * keeping one input and drawing three outputs off it.
 *
 * The consent stamp under the glyph column is not decoration: cloning refuses
 * without an ownership attestation (service/voices.py), so a picture of cloning
 * that omitted it would be drawing a code path that does not exist.
 */

const W = 640;
const H = 330;
const SRC_Y = 64;

const SOURCE = {
  w: 500,
  h: 80,
  x: 54,
  y: SRC_Y,
  amplitude: 0.92,
  frequency: 6,
  // 96, not 160: a morphing `d` interpolates every number in the string on
  // every frame, and three ribbons peeling at once is already ~600 tweened
  // values. At 5px per segment over this width the wave still reads as smooth.
  points: 96,
} as const;

/* Same point count as SOURCE — that is what makes the peel a morph rather than
 * a cut. Each speaker gets a different frequency and phase because they are
 * different voices, not three copies on three rows. */
const SPEAKERS: { name: string; tag: string; accent: Accent; y: number; f: number; p: number }[] = [
  { name: "sarah", tag: "narration", accent: "cyan", y: 146, f: 3.4, p: 0.2 },
  { name: "marcus", tag: "gruff", accent: "violet", y: 210, f: 8.2, p: 1.7 },
  { name: "ines", tag: "bright", accent: "emerald", y: 274, f: 5.1, p: 3.1 },
];

export default function CastSignal({ still }: { still: boolean }) {
  return (
    <div>
      <Illus w={W} h={H} grid>
        <Label x={54} y={20} size={11} still={still}>
          one paid scan
        </Label>

        {/* The source. Drawn first, dimmed once the cast has left it, never
            removed — one analysis, still standing. */}
        <motion.g
          initial={still ? { opacity: 0.3 } : { opacity: 1 }}
          animate={{ opacity: 0.3 }}
          transition={still ? undefined : { delay: 2.2, duration: 0.6 }}
        >
          <WaveLine wave={SOURCE} delay={0.1} duration={1} stroke="rgba(255,255,255,0.6)" width={1.6} still={still} />
        </motion.g>

        {SPEAKERS.map((s, i) => {
          const c = accentVar(s.accent);
          return (
            <g key={s.name}>
              {/* The peel: the speaker's share lights up ON the source line,
                  then travels down into a lane and shrinks. */}
              <WaveLine
                wave={SOURCE}
                morphTo={{ ...SOURCE, w: 420, h: 46, y: s.y, amplitude: 0.82, frequency: s.f, phase: s.p }}
                delay={1 + i * 0.18}
                duration={0.45}
                hold={0.1}
                morphDuration={0.8}
                stroke={c}
                width={1.6}
                still={still}
              />
              {/* Lead-out to the glyph that the lane resolves into. */}
              <Draw
                d={`M474 ${s.y} H540`}
                delay={2.5 + i * 0.12}
                duration={0.3}
                stroke={HAIR}
                width={1}
                still={still}
              />
              <Node x={556} y={s.y} r={6} accent={s.accent} delay={2.7 + i * 0.12} still={still} />
              <Label x={574} y={s.y - 1} size={11} accent={s.accent} delay={2.8 + i * 0.12} still={still}>
                {s.name}
              </Label>
              <Label x={574} y={s.y + 12} size={9} delay={2.85 + i * 0.12} still={still}>
                {s.tag}
              </Label>
            </g>
          );
        })}

        {/* The refusal condition, drawn as the seal it actually is. */}
        <Draw d="M508 300 H604" delay={3.2} duration={0.3} stroke={HAIR} width={1} still={still} />
        <Label x={556} y={318} anchor="middle" size={10} delay={3.3} still={still}>
          consent on file
        </Label>
      </Illus>

      <Caption delay={3.4} still={still}>
        One link, one paid analysis — and every speaker it separates becomes its
        own Character, each storing the attestation cloning refuses to run
        without.
      </Caption>
    </div>
  );
}
