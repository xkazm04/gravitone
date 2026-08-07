"use client";

import { motion } from "framer-motion";
import { CloudOff } from "lucide-react";
import { Chip, ConfirmBar, MONO, PreviewNote, ROW, Wave, pop, stamp } from "./shared";

/*
 * The boundary IS the feature, so the boundary is the drawing: one box with a
 * hard edge, everything inside it, and the cloud outside it crossed out.
 *
 * The $0.00 stamps in last because it is the consequence, not the claim — and
 * the limits line is here rather than in a footnote for the same reason
 * service/ingest.py::sovereign_limits() exists: a mode that quietly does less
 * is worse than one that says what it cannot do.
 */
const INSIDE = [
  { k: "transcribe", v: "faster-whisper · local" },
  { k: "diarize", v: "sherpa-onnx · ~34 MB, offline" },
  { k: "clone + speak", v: "your CPU" },
];

export default function SovereignPreview({ still }: { still: boolean }) {
  return (
    <div>
      {/* Outside the box: the thing that does not happen. */}
      <motion.div
        {...pop(0.1, still)}
        className={`${MONO} mb-3 flex items-center gap-2 rounded-xl border border-dashed border-white/12 px-3 py-2 text-white/30`}
      >
        <CloudOff className="h-3.5 w-3.5" aria-hidden />
        <span className="line-through">cloud transcription · cloud diarization · an API key</span>
      </motion.div>

      {/* The box. A solid cyan edge against the dashed line above it — the whole
          diagram is that one contrast. */}
      <motion.div
        {...pop(0.3, still)}
        className="rounded-2xl border p-3"
        style={{ borderColor: "color-mix(in srgb, var(--gt-accent-cyan) 40%, transparent)" }}
      >
        <div className="flex items-center justify-between">
          <span className={`${MONO} text-cyan-200/80`}>your machine</span>
          <Chip delay={0.45} still={still}>no keys set</Chip>
        </div>
        <Wave bars={30} className="mt-3 h-8 w-full" delay={0.4} still={still} />
        <div className="mt-3 space-y-1.5">
          {INSIDE.map((r, i) => (
            <motion.div key={r.k} {...pop(0.6 + i * 0.1, still)} className={`${MONO} flex items-baseline gap-2`}>
              <span className="text-white/35">{r.k}</span>
              <span className="ml-auto text-white/70">{r.v}</span>
            </motion.div>
          ))}
        </div>
      </motion.div>

      <div className="mt-4 flex items-center gap-3">
        <motion.span {...stamp(0.95, still)} className="font-instrument text-3xl text-emerald-200">
          $0.00
        </motion.span>
        <span className={`${MONO} text-white/45`}>per minute of audio analysed</span>
      </div>

      <ConfirmBar accent="cyan" delay={1.05} still={still}>
        consent receipt still recorded · the attestation never leaves either
      </ConfirmBar>

      <PreviewNote delay={1.15} still={still}>
        The mode reports its own limits instead of degrading quietly — what it
        cannot do offline, it says, rather than guessing and calling it a result.
      </PreviewNote>
    </div>
  );
}
