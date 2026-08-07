"use client";

import { motion } from "framer-motion";
import { BENCHMARKS, HARNESS } from "@/lib/benchmarks";
import { Caption, Draw, HAIR, Stage, Tag, accentVar, pop, stamp } from "./illus";

/*
 * arm · STAGE — four identical engines, four meters, one measured ribbon.
 *
 * The sizing advice is the scene: N single-worker PROCESSES, not one process
 * with N threads, because the model is GIL-bound. So the stage holds four
 * indistinguishable boxes — same card, same meter, same "1 worker" tag — and
 * their tapes converge into one ribbon downstage. Four of a thing and one
 * output is a shape a list of numbers cannot make.
 *
 * Every figure is read from lib/benchmarks.ts, the measured table the public
 * /benchmarks page renders. Nothing here is retyped, including the meter: the
 * fill is the CPU the box was actually sitting at when it hit the knee, which is
 * both a real measurement and the reason the ribbon is the length it is.
 *
 * THE RIBBON IS DRAWN TO SCALE and that is where the honesty lives. Its full
 * width is what four times a single stream would have been; the lit part is what
 * was measured. The hatched remainder is not a rounding error, it is the cost of
 * running four replicas on one box — and a marketing diagram that filled the bar
 * would be claiming a number nobody could reproduce with the script named at the
 * bottom of the same picture.
 */

const C8G = BENCHMARKS.find((b) => b.id === "c8g-2xlarge") ?? BENCHMARKS[0];
const RTF = C8G.singleStreamRtf;
const PROCS = C8G.processes ?? 1;
const AGG = C8G.multiProcessAudPerS ?? RTF;
/** What the ribbon WOULD have been if throughput scaled linearly by replica. */
const LINEAR = Math.round(RTF * PROCS * 10) / 10;

/** The four tapes' origins across the fan, in its own user units. */
const FAN_X = [75, 225, 375, 525];

export default function ArmStage({ still }: { still: boolean }) {
  return (
    <div>
      <Stage accent="cyan" className="px-4 pb-4 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-jetbrains text-[10px] text-white/40">
            {C8G.instance ?? C8G.platform} · {C8G.cpu} · {C8G.vcpu} vCPU
          </span>
          <Tag delay={0.15} still={still}>
            no gpu
          </Tag>
        </div>

        {/* The engines. Deliberately identical — that is the sizing advice. */}
        <div className="mt-3 grid grid-cols-4 gap-2">
          {Array.from({ length: PROCS }, (_, i) => i).map((i) => (
            <motion.div
              key={i}
              {...pop(0.25 + i * 0.12, still)}
              className="rounded-lg border px-2 py-2"
              style={{
                borderColor: `color-mix(in srgb, ${accentVar("cyan")} 30%, transparent)`,
                background: `color-mix(in srgb, ${accentVar("cyan")} 6%, transparent)`,
              }}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-jetbrains text-[11px] text-cyan-200/85">r{i + 1}</span>
                <span className="font-jetbrains text-[9px] uppercase tracking-[0.12em] text-white/30">
                  1 worker
                </span>
              </div>
              {/* The meter, filled to the CPU the box actually sat at. */}
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8">
                <motion.div
                  initial={still ? { scaleX: 1 } : { scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={still ? undefined : { delay: 0.75 + i * 0.1, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                  className="h-full origin-left rounded-full"
                  style={{
                    width: `${C8G.cpuAtCeilingPct ?? 100}%`,
                    background: accentVar("cyan"),
                  }}
                />
              </div>
              {C8G.cpuAtCeilingPct != null && (
                <div className="font-jetbrains mt-1.5 text-[9px] text-white/35">
                  {C8G.cpuAtCeilingPct}% cpu
                </div>
              )}
            </motion.div>
          ))}
        </div>

        {/* Four tapes, one ribbon. */}
        <svg viewBox="0 0 600 48" className="h-11 w-full" preserveAspectRatio="none" aria-hidden>
          {FAN_X.slice(0, PROCS).map((x, i) => (
            <Draw
              key={x}
              d={`M${x} 0 C${x} 26 300 22 300 46`}
              delay={1.2 + i * 0.08}
              duration={0.45}
              stroke={HAIR}
              width={1.4}
              still={still}
            />
          ))}
        </svg>

        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <motion.span {...stamp(1.7, still)} className="font-instrument text-3xl leading-none text-white">
            {AGG}
          </motion.span>
          <span className="font-jetbrains text-[11px] text-white/45">
            audio-seconds every second
          </span>
          <span className="font-jetbrains ml-auto text-[10px] text-white/30">
            {RTF}× single stream
          </span>
        </div>

        {/* Drawn to scale against the linear expectation it does not reach. */}
        <div className="mt-2 flex h-3.5 overflow-hidden rounded-full border border-white/12">
          <motion.div
            initial={still ? { scaleX: 1 } : { scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={still ? undefined : { delay: 1.9, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className="origin-left"
            style={{
              flexGrow: AGG,
              flexBasis: 0,
              background: `linear-gradient(90deg, color-mix(in srgb, ${accentVar(
                "cyan",
              )} 26%, transparent), color-mix(in srgb, ${accentVar("cyan")} 62%, transparent))`,
            }}
          />
          <div
            className="border-l border-white/15"
            style={{
              flexGrow: Math.max(LINEAR - AGG, 0.1),
              flexBasis: 0,
              background:
                "repeating-linear-gradient(-45deg, rgba(255,255,255,0.08) 0 3px, transparent 3px 7px)",
            }}
          />
        </div>
        <div className="mt-1.5 flex items-baseline justify-between">
          <motion.span
            {...pop(2.35, still)}
            className="font-jetbrains text-[9px] uppercase tracking-[0.14em] text-cyan-200/80"
          >
            measured, {PROCS} replicas
          </motion.span>
          <motion.span
            {...pop(2.45, still)}
            className="font-jetbrains text-[9px] uppercase tracking-[0.14em] text-white/30"
          >
            linear would be {LINEAR}
          </motion.span>
        </div>

        <motion.div
          {...stamp(2.6, still)}
          className="font-jetbrains mt-3 w-fit rounded-md border px-2 py-1 text-[10px]"
          style={{
            borderColor: `color-mix(in srgb, ${accentVar("emerald")} 34%, transparent)`,
            background: `color-mix(in srgb, ${accentVar("emerald")} 8%, transparent)`,
            color: accentVar("emerald"),
          }}
          title={HARNESS.method}
        >
          bash benchmark_arm.sh
        </motion.div>
      </Stage>

      <Caption delay={2.9} still={still}>
        {`${PROCS} single-worker replicas on one Arm box, measured at ${AGG} audio-seconds per second — short of ${LINEAR}, because scaling by process is real but not free, and you can run the script yourself.`}
      </Caption>
    </div>
  );
}
