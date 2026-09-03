"use client";

import { motion } from "framer-motion";
import { Caption, Draw, HAIR, Illus, Label, Node, TravelPulse, WaveLine, accentVar } from "./illus";

/*
 * score · SIGNAL — one line, three regions, and the one that could not be sung.
 *
 * The editing model is regions over text, so the drawing is a single utterance
 * cut into spans: the words sit under the trace and never move, brackets close
 * over them from above, and the WAVE ITSELF changes character exactly at the
 * boundaries. That change is the whole mechanism — an emotion is not a filter
 * over the take, it is a different embedding for that span — and it is carried
 * by shape rather than by hue, which is why this diagram can keep to one accent
 * where CastSignal could not.
 *
 * Every region draws in the same neutral shape first and then MORPHS into its
 * emotion. The neutral is what the line would have been; the morph is the
 * direction being applied. It is one path per region throughout, so the eye
 * reads a change rather than a substitution.
 *
 * THE THIRD REGION IS THE HONEST ONE, and it is honest by not moving. `whisper`
 * is an emotion this Character has no embedding for, so that span never morphs:
 * it draws neutral and stays neutral, its label is struck in place (not
 * deleted — you asked for it, and the response says so), and a dashed detour
 * carries the fallback back to the caller as a line in the per-segment report.
 * A silent substitution would have looked identical on the page, which is
 * exactly why an entire rail is spent on saying it out loud.
 *
 * ONE ACCENT. Violet is "rendered as marked". The third region, its fallback
 * and the report rail are all hairline white — so what the colour is missing
 * from is precisely what the engine could not deliver.
 */

const W = 640;
const H = 340;
const VIOLET = accentVar("violet");
const WAVE_Y = 132;

/* Shared by every region and every morph target. A region is a slice of one
 * utterance, so it keeps the utterance's sample structure. */
const BASE = { h: 88, y: WAVE_Y, points: 64, damp: 0.15 } as const;

const REGIONS = [
  {
    text: "you came back.",
    emotion: "warm",
    x: 48,
    w: 184,
    /* Slow, round, little inharmonic content. */
    to: { amplitude: 0.72, frequency: 2.6, harmonic: 0.18, phase: 0.2 },
  },
  {
    text: "after everything.",
    emotion: "wry",
    x: 232,
    w: 160,
    /* Tighter and more irregular — a different embedding, not a volume knob. */
    to: { amplitude: 0.52, frequency: 6.4, harmonic: 0.55, phase: 1.4 },
  },
  {
    text: "don't say a word.",
    emotion: "whisper",
    x: 392,
    w: 200,
    /* No morph target: this one does not move, and that IS the drawing. */
    to: null,
  },
] as const;

/** The line as it stands before any direction is applied. */
const neutral = (x: number, w: number) =>
  ({ ...BASE, x, w, amplitude: 0.45, frequency: 4.4, harmonic: 0.35, phase: 0.6 }) as const;

const DETOUR = "M492 236 C492 274 468 290 414 290 H196";
const ARROW = "M206 284 L194 290 L206 296";

export default function ScoreSignal({ still }: { still: boolean }) {
  return (
    <div>
      <Illus w={W} h={H} grid>
        <Label x={48} y={30} size={11} still={still}>
          one line · three regions
        </Label>

        {REGIONS.map((r, i) => {
          const cx = r.x + r.w / 2;
          const marked = r.to !== null;
          const stroke = marked ? VIOLET : "rgba(255,255,255,0.55)";
          return (
            <g key={r.emotion}>
              {/* The words. Drawn first — the regions are marked OVER text that
                  was already there and never moves. */}
              <Label x={cx} y={224} anchor="middle" size={10} delay={0.1 + i * 0.06} still={still}>
                {r.text}
              </Label>

              {/* The span itself: neutral, then the direction. */}
              <WaveLine
                wave={neutral(r.x, r.w)}
                morphTo={r.to ? { ...neutral(r.x, r.w), ...r.to } : undefined}
                delay={0.4 + i * 0.16}
                duration={0.5}
                hold={0.2}
                morphDuration={0.6}
                stroke={stroke}
                width={1.6}
                still={still}
              />

              {/* The bracket that closes over the span. */}
              <Draw
                d={`M${r.x + 4} 78 V66 H${r.x + r.w - 4} V78`}
                delay={1.5 + i * 0.1}
                duration={0.35}
                stroke={HAIR}
                width={1.2}
                still={still}
              />
            </g>
          );
        })}

        {/* The boundaries. The switch happens HERE, and the trace changes here
            too — the dashes are only naming what the wave already did. */}
        {[232, 392].map((x) => (
          <Draw
            key={x}
            d={`M${x} 66 V208`}
            delay={1.35}
            duration={0.4}
            stroke={HAIR}
            width={1}
            dashed
            still={still}
          />
        ))}

        <Label x={140} y={58} anchor="middle" size={10} accent="violet" delay={1.7} still={still}>
          warm
        </Label>
        <Label x={312} y={58} anchor="middle" size={10} accent="violet" delay={1.8} still={still}>
          wry
        </Label>

        {/* The one you asked for, dimmed and struck IN PLACE — never removed,
            because it is still what the request said. */}
        <motion.g
          initial={still ? { opacity: 0.3 } : { opacity: 1 }}
          animate={{ opacity: 0.3 }}
          transition={still ? undefined : { delay: 2.25, duration: 0.45 }}
        >
          <Label x={486} y={58} anchor="end" size={10} delay={1.9} still={still}>
            whisper
          </Label>
        </motion.g>
        <motion.g
          initial={still ? { opacity: 1 } : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={still ? undefined : { delay: 2.3, duration: 0.3 }}
        >
          <path d="M430 55 H490" stroke="rgba(255,255,255,0.5)" strokeWidth={1.4} strokeLinecap="round" />
        </motion.g>
        <Label x={498} y={58} size={10} delay={2.4} still={still}>
          → baseline
        </Label>

        {/* The fallback, travelling back to the caller as a named line. */}
        <Draw d={DETOUR} delay={2.5} duration={0.6} stroke={HAIR} width={1.2} dashed still={still} />
        <Draw d={ARROW} delay={3} duration={0.2} stroke={HAIR} width={1.4} still={still} />
        <TravelPulse
          d={DETOUR}
          delay={2.7}
          duration={0.7}
          color="rgba(255,255,255,0.75)"
          size={4}
          still={still}
        />
        <Node x={188} y={290} r={3.5} delay={3.05} still={still} />
        <Label x={178} y={293} anchor="end" size={9} delay={3.1} still={still}>
          your response
        </Label>
        <Label x={340} y={310} anchor="middle" size={9} delay={3} still={still}>
          reported per segment
        </Label>
      </Illus>

      <Caption delay={3.2} still={still}>
        Direction is marked in spans and the voice changes at the boundary — and
        an emotion this Character has no embedding for stays baseline and comes
        back named on that segment, never swapped behind you.
      </Caption>
    </div>
  );
}
