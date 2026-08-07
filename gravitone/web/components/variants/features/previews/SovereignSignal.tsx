"use client";

import { motion } from "framer-motion";
import { Caption, Draw, HAIR, Illus, Label, Node, TravelPulse, WaveLine, accentVar } from "./illus";

/*
 * sovereign · SIGNAL — one box, and a signal that cannot get out of it.
 *
 * The boundary IS the feature, so the boundary is the first thing drawn and the
 * only coloured thing in the frame. Everything the mode does happens INSIDE that
 * cyan rectangle; the cloud sits outside it, dashed and unlit, and is never
 * touched by anything.
 *
 * The load-bearing gesture is the U-turn. A route that simply stopped short
 * would read as "not drawn yet"; a route that leaves the recording, runs at the
 * wall, and comes back with an arrowhead pointing home is a picture of a
 * refusal. It is drawn in the boundary's own colour because it is the boundary
 * acting, not a separate feature.
 *
 * Inside, the recording peels into two speaker traces — the ~34 MB offline
 * diarizer, on this CPU, at $0. Nothing is added at the split (the second voice
 * was always in the file); the bracket under the source is what did the work.
 *
 * THE HONEST LIMIT IS DRAWN, TWICE, because this mode ships two of them
 * (service/ingest.py::sovereign_limits). The dashed brace tying the two lanes
 * back together is the speaker count being a hypothesis that skews HIGH — one
 * person can come back as two, and the brace is the drawing saying those two
 * lanes might be one. And `baseline emotions only` sits inside the box, because
 * there is no local emotion classifier and the mode says so rather than
 * guessing.
 *
 * ONE ACCENT. Cyan is the machine's edge and its refusal to cross it. The
 * source, the split, the diarizer and the caveats are all hairline white, so
 * the single coloured shape on screen is the promise the feature is named for.
 */

const W = 640;
const H = 344;
const CYAN = accentVar("cyan");

const BOX = "M32 40 H470 V306 H32 Z";
const CLOUD = "M508 96 H616 V150 H508 Z";
/* Out of the recording, at the wall, and back — one stroke, so the return is
 * the same signal rather than a second one. */
const TURN = "M366 116 H442 C462 116 462 152 442 152 H392";
const ARROW = "M400 146 L392 152 L400 158";
const BRACKET = "M76 148 V160 H356 V148";
/* The two lanes, tied back together: the count is a guess. */
const BRACE = "M364 214 C392 214 392 266 364 266";

const SOURCE = {
  w: 310,
  h: 64,
  x: 56,
  y: 104,
  amplitude: 0.9,
  frequency: 5.4,
  // Shared with both lane targets — same command structure, so the peel is a
  // morph and not a cut.
  points: 96,
} as const;

const LANES = [
  { name: "speaker a", y: 214, f: 3.2, p: 0.4 },
  { name: "speaker b", y: 266, f: 7.6, p: 2.2 },
];

export default function SovereignSignal({ still }: { still: boolean }) {
  return (
    <div>
      <Illus w={W} h={H} grid>
        {/* The boundary. Drawn first and drawn whole — everything after this is
            inside it or refused by it. */}
        <Draw d={BOX} delay={0.05} duration={1} stroke={CYAN} width={1.8} still={still} />
        <Label x={46} y={62} size={11} accent="cyan" delay={0.55} still={still}>
          your machine
        </Label>
        <Label x={456} y={62} anchor="end" size={11} delay={0.6} still={still}>
          no keys set
        </Label>

        {/* Outside, and unvisited. Dashed because it is a place, not a route. */}
        <Draw d={CLOUD} delay={0.7} duration={0.6} stroke={HAIR} width={1.2} dashed still={still} />
        <Label x={562} y={126} anchor="middle" size={10} delay={1} still={still}>
          cloud · api key
        </Label>
        <Label x={562} y={172} anchor="middle" size={10} delay={2.4} still={still}>
          never dialled
        </Label>

        {/* The recording. */}
        <motion.g
          initial={still ? { opacity: 0.32 } : { opacity: 1 }}
          animate={{ opacity: 0.32 }}
          transition={still ? undefined : { delay: 2.3, duration: 0.5 }}
        >
          <WaveLine
            wave={SOURCE}
            delay={0.35}
            duration={0.85}
            stroke="rgba(255,255,255,0.5)"
            width={1.6}
            still={still}
          />
        </motion.g>

        {/* The attempt, the wall, the return. */}
        <Draw d={TURN} delay={1.15} duration={0.55} stroke={CYAN} width={1.6} still={still} />
        <Draw d={ARROW} delay={1.65} duration={0.2} stroke={CYAN} width={1.6} still={still} />
        <TravelPulse d={TURN} delay={1.3} duration={0.95} color={CYAN} size={4.5} restAt={1} still={still} />
        <Label x={440} y={180} anchor="middle" size={10} accent="cyan" delay={1.9} still={still}>
          nothing leaves
        </Label>

        {/* What did the separating, named where it happens. */}
        <Draw d={BRACKET} delay={1.45} duration={0.4} stroke={HAIR} width={1} still={still} />
        <Node x={216} y={160} r={4} delay={1.6} still={still} />
        <Label x={232} y={157} size={10} delay={1.65} still={still}>
          local diarizer
        </Label>
        <Label x={232} y={171} size={9} delay={1.7} still={still}>
          34 mb · $0
        </Label>

        {/* The peel. Each speaker's share lights up ON the source line, then
            travels into a lane of its own — nothing added, only separated. */}
        {LANES.map((l, i) => (
          <g key={l.name}>
            <WaveLine
              wave={SOURCE}
              morphTo={{ ...SOURCE, w: 280, h: 48, x: 76, y: l.y, amplitude: 0.8, frequency: l.f, phase: l.p }}
              delay={1.75 + i * 0.16}
              duration={0.4}
              hold={0.05}
              morphDuration={0.7}
              stroke="rgba(255,255,255,0.85)"
              width={1.5}
              still={still}
            />
            <Label x={68} y={l.y + 3} anchor="end" size={10} delay={2.6 + i * 0.1} still={still}>
              {l.name}
            </Label>
          </g>
        ))}

        {/* The count is a guess — so the two lanes are tied back together. */}
        <Draw d={BRACE} delay={2.75} duration={0.4} stroke={HAIR} width={1.2} dashed still={still} />
        <Label x={398} y={234} size={9} delay={2.9} still={still}>
          hypothesis
        </Label>
        <Label x={398} y={248} size={9} delay={2.95} still={still}>
          skews high
        </Label>

        {/* The other limit this mode declares out loud. */}
        <Label x={46} y={294} size={9} delay={3} still={still}>
          baseline emotions only
        </Label>
      </Illus>

      <Caption delay={3.1} still={still}>
        Nothing crosses the edge — the ~34 MB offline diarizer separates the
        speakers on your own CPU for $0, and says the count it returns is a
        hypothesis rather than pretending it is a fact.
      </Caption>
    </div>
  );
}
