"use client";

import { motion } from "framer-motion";
import { BENCHMARKS, HARNESS } from "@/lib/benchmarks";
import { Chip, ConfirmBar, MONO, PreviewNote, ROW, pop, stamp } from "./shared";

/*
 * The only preview that quotes measured numbers, so it is the only one that
 * imports them. Every figure below comes out of lib/benchmarks.ts — the same
 * dataset the public /benchmarks page renders, transcribed from the measured
 * table — because a marketing diagram with its own copy of a benchmark is a
 * benchmark that will be stale by the next run and nobody will notice.
 *
 * What it draws is the finding, not just the score: throughput scales by
 * PROCESS, not by in-process worker (the model is GIL-bound), so the boxes
 * multiply left to right and the aud/s figure rides the whole row rather than
 * any single box.
 */
const C8G = BENCHMARKS.find((b) => b.id === "c8g-2xlarge") ?? BENCHMARKS[0];

export default function ArmPreview({ still }: { still: boolean }) {
  const replicas = C8G.processes ?? 1;
  return (
    <div>
      <div className={`${ROW} py-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={`${MONO} text-white/40`}>
            {C8G.instance} · {C8G.cpu} · {C8G.vcpu} vCPU
          </span>
          <Chip delay={0.15} still={still}>no GPU</Chip>
        </div>

        {/* One replica, then four. The row IS the scaling claim. */}
        <div className="mt-3 flex items-stretch gap-2">
          {Array.from({ length: replicas }, (_, i) => (
            <motion.div
              key={i}
              {...pop(0.25 + i * 0.14, still)}
              className="flex-1 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.06] px-2 py-2.5 text-center"
            >
              <div className={`${MONO} text-cyan-200/80`}>w{i + 1}</div>
              <div className={`${MONO} mt-1 text-white/35`}>1 worker</div>
            </motion.div>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <motion.div {...stamp(0.85, still)}>
            <div className="font-instrument text-3xl leading-none text-white">{C8G.singleStreamRtf}×</div>
            <div className={`${MONO} mt-1.5 text-white/45`}>realtime, one stream</div>
          </motion.div>
          {C8G.multiProcessAudPerS != null && (
            <motion.div {...stamp(1, still)}>
              <div className="font-instrument text-3xl leading-none text-white">{C8G.multiProcessAudPerS}</div>
              <div className={`${MONO} mt-1.5 text-white/45`}>
                audio-seconds per second, {replicas} replicas
              </div>
            </motion.div>
          )}
        </div>
      </div>

      <ConfirmBar accent="emerald" delay={1.1} still={still}>
        reproduce it: {HARNESS.reproduce}
      </ConfirmBar>

      <PreviewNote delay={1.2} still={still}>
        Throughput scales by process, not by in-process worker — so the sizing
        advice is N single-worker replicas, and every row on the benchmarks page
        was produced by the script above rather than by us.
      </PreviewNote>
    </div>
  );
}
