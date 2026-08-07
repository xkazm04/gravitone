"use client";

import { motion } from "framer-motion";
import { Caption, Draw, HAIR, Stage, Tag, accentVar, pop, stamp, type Accent } from "./illus";
import { Wave } from "./shared";

/*
 * cast · STAGE — the screen up top, the cast it came out of down front.
 *
 * A casting scene: one source on the far wall, a fan of light coming off it,
 * and three Characters standing downstage under it. The fan is the load-bearing
 * shape — three lines from ONE origin is the entire claim, and it is the only
 * part of this drawing that could not be replaced by a list.
 *
 * Each card is a person, so each gets a colour, a face, and a voice of its own
 * (the mini waveforms differ per card, because three identical ones would draw
 * the blended average this feature exists to refuse).
 *
 * The consent receipt stamps onto each card LAST and hardest — it is the
 * gate, not the garnish. Cloning refuses without an ownership attestation
 * (service/voices.py), so a card without its seal would be a Character that
 * cannot exist.
 */

const CAST: { name: string; role: string; accent: Accent }[] = [
  { name: "Sarah", role: "narration", accent: "cyan" },
  { name: "Marcus", role: "gruff", accent: "violet" },
  { name: "Ines", role: "bright", accent: "emerald" },
];

export default function CastStage({ still }: { still: boolean }) {
  return (
    <div>
      <Stage accent="violet" className="px-4 pb-4 pt-4">
        {/* The source, upstage: one screen, one scan. */}
        <motion.div
          {...pop(0.05, still)}
          className="mx-auto w-[74%] rounded-xl border border-white/12 bg-white/[0.03] px-3 py-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-jetbrains truncate text-[10px] text-white/40">
              youtube.com/watch?v=…
            </span>
            <Tag delay={0.3} still={still}>
              1 paid scan
            </Tag>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            {/* A filmstrip, so the source reads as footage and not as a form. */}
            {Array.from({ length: 6 }, (_, i) => (
              <motion.span
                key={i}
                {...pop(0.15 + i * 0.05, still)}
                className="h-6 flex-1 rounded-[3px] border border-white/10 bg-white/[0.05]"
              />
            ))}
          </div>
          <Wave bars={40} className="mt-2 h-5 w-full" accent="violet" delay={0.5} still={still} />
        </motion.div>

        {/* The fan. One origin, three destinations — the shape IS the claim. */}
        <svg viewBox="0 0 600 52" className="h-11 w-full" preserveAspectRatio="none" aria-hidden>
          {[100, 300, 500].map((x, i) => (
            <Draw
              key={x}
              d={`M300 0 C300 26 ${x} 20 ${x} 50`}
              delay={0.85 + i * 0.1}
              duration={0.45}
              stroke={HAIR}
              width={1.4}
              still={still}
            />
          ))}
        </svg>

        {/* Downstage: the cast. */}
        <div className="grid grid-cols-3 gap-2.5">
          {CAST.map((c, i) => {
            const a = accentVar(c.accent);
            return (
              <motion.div
                key={c.name}
                {...pop(1.25 + i * 0.12, still)}
                className="rounded-xl border px-2.5 py-2.5"
                style={{
                  borderColor: `color-mix(in srgb, ${a} 36%, transparent)`,
                  background: `color-mix(in srgb, ${a} 7%, transparent)`,
                  boxShadow: `0 16px 40px -30px ${a}`,
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-6 w-6 shrink-0 rounded-full"
                    style={{
                      background: `radial-gradient(circle at 32% 28%, ${a}, transparent 74%)`,
                      border: `1px solid color-mix(in srgb, ${a} 50%, transparent)`,
                    }}
                  />
                  <span className="truncate text-[13px] leading-tight text-white">{c.name}</span>
                </div>
                {/* Different bar counts → different voices. */}
                <Wave
                  bars={9 + i * 3}
                  className="mt-2 h-6 w-full"
                  accent={c.accent}
                  delay={1.5 + i * 0.12}
                  still={still}
                />
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <Tag accent={c.accent} delay={1.7 + i * 0.1} still={still}>
                    {c.role}
                  </Tag>
                </div>
                <motion.div
                  {...stamp(2.1 + i * 0.14, still)}
                  className="font-jetbrains mt-2 flex items-center gap-1 rounded-md border px-1.5 py-1 text-[9px] uppercase tracking-[0.12em]"
                  style={{
                    borderColor: `color-mix(in srgb, ${accentVar("emerald")} 34%, transparent)`,
                    color: accentVar("emerald"),
                  }}
                >
                  <span aria-hidden>✓</span> consent receipt
                </motion.div>
              </motion.div>
            );
          })}
        </div>
      </Stage>

      <Caption delay={2.6} still={still}>
        One paid analysis, a whole cast — each Character keeping the attestation
        its speaker agreed to, because cloning refuses to run without one.
      </Caption>
    </div>
  );
}
