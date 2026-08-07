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
 * compat · SIGNAL — "the line moves, the wave doesn't."
 *
 * The claim on the card is drop-in compatibility, and the honest version of
 * that claim is a statement about what did NOT change. So the drawing is built
 * around one fixed object: a waveform sitting on the wire, drawn once, never
 * redrawn, with a caliper under it. Everything that moves is routing.
 *
 * The route leaves the junction and goes UP to api.elevenlabs.io first, because
 * that is where the reader's existing client points today. It is struck out and
 * dimmed in place rather than deleted — a route that vanishes reads as "that
 * never existed", and what actually happened is that one string changed.
 *
 * The honest limit is the return arc. A setting this engine accepts but does
 * not act on comes back NAMED, on X-Ignored-Settings — so it is drawn as
 * something that leaves the box and travels back to the caller, not as a
 * footnote. Silently dropping it would have looked identical from the outside,
 * which is exactly why the diagram spends a whole arc on it.
 *
 * ONE ACCENT. Cyan is the new route and nothing else; the payload, the old
 * host, the caliper and the return arc are all hairline white, so the single
 * coloured thing on screen is the one thing the reader has to change.
 */

const W = 640;
const H = 320;
const CYAN = accentVar("cyan");

const TRUNK = "M52 128 H180";
const PAYLOAD = wavePath({ w: 150, h: 84, x: 180, y: 128, amplitude: 0.86, frequency: 3.4, points: 120 });
const LINK = "M330 128 H358";
const ROUTE_OLD = "M358 128 C412 128 420 58 490 58";
const ROUTE_NEW = "M358 128 C412 128 420 198 490 198";
const CALIPER = "M180 178 V186 H330 V178";
const RETURN = "M496 214 C430 282 240 294 108 268";
const ARROW = "M118 262 L106 268 L118 274";

export default function CompatSignal({ still }: { still: boolean }) {
  return (
    <div>
      <Illus w={W} h={H} grid>
        {/* The caller, and the wire out of it. */}
        <Label x={36} y={102} size={11} still={still}>
          your client
        </Label>
        <Node x={52} y={128} delay={0.05} still={still} />
        <Draw d={TRUNK} delay={0.1} duration={0.4} still={still} />

        {/* The payload. Drawn ONCE, and never touched again — the caliper is
            there so the eye can check that claim against the picture. */}
        <Draw d={PAYLOAD} delay={0.25} duration={0.7} width={1.6} stroke="rgba(255,255,255,0.55)" still={still} />
        <Draw d={LINK} delay={0.8} duration={0.25} still={still} />
        <Draw d={CALIPER} delay={0.75} duration={0.4} stroke={HAIR} width={1} still={still} />
        <Label x={255} y={202} anchor="middle" size={11} delay={0.95} still={still}>
          unchanged
        </Label>

        {/* The junction: one decision, two destinations. */}
        <Node x={358} y={128} r={4} delay={0.85} still={still} />

        {/* The old route — drawn solid, then struck and dimmed in place. */}
        <motion.g
          initial={still ? { opacity: 0.22 } : { opacity: 1 }}
          animate={{ opacity: 0.22 }}
          transition={still ? undefined : { delay: 1.75, duration: 0.5 }}
        >
          <Draw d={ROUTE_OLD} delay={0.9} duration={0.5} still={still} />
          <Node x={490} y={58} r={4} delay={1.4} still={still} />
          <Label x={506} y={62} size={11} delay={1.45} still={still}>
            api.elevenlabs.io
          </Label>
        </motion.g>
        <motion.g
          initial={still ? { opacity: 1 } : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={still ? undefined : { delay: 1.8, duration: 0.3 }}
        >
          <path d="M411 86 L425 100" stroke="rgba(255,255,255,0.5)" strokeWidth={1.6} strokeLinecap="round" />
          <path d="M425 86 L411 100" stroke="rgba(255,255,255,0.5)" strokeWidth={1.6} strokeLinecap="round" />
        </motion.g>

        {/* The new route. The only coloured thing in the frame. */}
        <Draw d={ROUTE_NEW} delay={1.85} duration={0.5} stroke={CYAN} width={1.8} still={still} />
        <Node x={490} y={198} r={5} accent="cyan" delay={2.3} still={still} />
        <Label x={506} y={202} size={11} accent="cyan" delay={2.35} still={still}>
          your-arm-box
        </Label>
        <TravelPulse d={ROUTE_NEW} delay={2.4} duration={0.75} color={CYAN} still={still} />

        {/* The honest limit, as a thing that travels back to you. */}
        <Draw d={RETURN} delay={2.9} duration={0.6} stroke={HAIR} width={1.2} still={still} />
        <Draw d={ARROW} delay={3.4} duration={0.2} stroke={HAIR} width={1.4} still={still} />
        <Label x={327} y={310} anchor="middle" size={11} delay={3.3} still={still}>
          x-ignored-settings
        </Label>
        <TravelPulse
          d={RETURN}
          delay={3.1}
          duration={0.7}
          color="rgba(255,255,255,0.75)"
          size={4}
          restAt={1}
          still={still}
        />
      </Illus>

      <Caption delay={3.5} still={still}>
        One base URL moves. The request does not — and a setting this engine
        accepts but does not act on rides back to you named, never silently
        dropped.
      </Caption>
    </div>
  );
}
