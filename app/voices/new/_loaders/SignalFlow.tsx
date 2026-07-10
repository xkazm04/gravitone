"use client";

// SIGNAL FLOW — the recording flows through 4 processing nodes; energy pulses
// along the rail up to the active stage, each node shows its live stat, and a
// readout below streams the real intermediate data (speakers / transcript /
// emotion tally). SVG motion in service of "what is happening right now."

import { motion } from "framer-motion";
import { EmotionTally, stateOf, type LoaderData } from "./shared";

const NODES = [
  { key: "transcribe", label: "Transcribe" },
  { key: "isolate", label: "Isolate" },
  { key: "label", label: "Label" },
  { key: "stem", label: "Stem" },
];
const W = 680, PAD = 70;
const XS = NODES.map((_, i) => PAD + (i * (W - 2 * PAD)) / (NODES.length - 1));

export default function SignalFlow({ data }: { data: LoaderData }) {
  const st = (k: string) => stateOf(data, k);
  const activeIdx = NODES.findIndex((n) => st(n.key) === "active");
  const doneCount = NODES.filter((n) => st(n.key) === "done").length;
  const frontier = Math.min(NODES.length - 1, Math.max(activeIdx, doneCount));
  const p = data.partial;

  const statFor = (key: string): string => {
    if (key === "transcribe") return p.words ? `${p.words} words` : "";
    if (key === "isolate") return st(key) === "done" || st(key) === "active" ? "clean" : "";
    if (key === "label") return p.segments_total ? `${p.segments_done ?? 0}/${p.segments_total}` : "";
    return "";
  };

  return (
    <div>
      <svg viewBox={`0 0 ${W} 150`} className="w-full">
        <line x1={PAD} y1={70} x2={W - PAD} y2={70} stroke="rgba(255,255,255,0.1)" />
        <motion.line
          x1={PAD} y1={70} x2={XS[frontier]} y2={70} stroke="#67e8f9" strokeWidth={2}
          strokeDasharray="3 7" initial={false}
          animate={{ strokeDashoffset: [0, -20] }} transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}
        />
        {activeIdx > 0 && (
          <motion.g initial={false} animate={{ x: [XS[activeIdx - 1], XS[activeIdx]] }}
            transition={{ repeat: Infinity, duration: 1.1, ease: "easeInOut" }}>
            <circle cx={0} cy={70} r={4} fill="#a5f3fc" />
          </motion.g>
        )}
        {NODES.map((n, i) => {
          const s = st(n.key);
          const stroke = s === "done" ? "#34d399" : s === "active" ? "#67e8f9" : "rgba(255,255,255,0.22)";
          return (
            <g key={n.key}>
              {s === "active" && (
                <motion.circle cx={XS[i]} cy={70} r={13} fill="none" stroke="#67e8f9" strokeWidth={1.5}
                  initial={{ opacity: 0.6, scale: 1 }} animate={{ opacity: 0, scale: 2.1 }}
                  transition={{ repeat: Infinity, duration: 1.4, ease: "easeOut" }}
                  style={{ transformOrigin: `${XS[i]}px 70px` }} />
              )}
              <circle cx={XS[i]} cy={70} r={14} fill="#0b0e15" stroke={stroke} strokeWidth={2} />
              {s === "done" && <text x={XS[i]} y={75} textAnchor="middle" fill="#34d399" fontSize={14}>✓</text>}
              {s === "active" && <text x={XS[i]} y={75} textAnchor="middle" fill="#67e8f9" fontSize={14}>•</text>}
              <text x={XS[i]} y={106} textAnchor="middle" fontSize={11} className="font-jetbrains"
                fill={s === "pending" ? "rgba(255,255,255,0.45)" : "#fff"}>{n.label}</text>
              {statFor(n.key) && (
                <text x={XS[i]} y={124} textAnchor="middle" fill="#67e8f9" fontSize={10} className="font-jetbrains">
                  {statFor(n.key)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div className="mt-2 min-h-[60px]">
        {p.emotion_counts ? (
          <EmotionTally counts={p.emotion_counts} />
        ) : p.speakers ? (
          <div className="flex flex-wrap justify-center gap-1.5">
            {p.speakers.map((s) => (
              <span key={s} className="font-jetbrains rounded-full border border-white/12 bg-white/5 px-2.5 py-0.5 text-[10px] text-white/65">{s}</span>
            ))}
          </div>
        ) : null}
        {p.transcript && !p.emotion_counts && (
          <p className="mx-auto mt-3 line-clamp-2 max-w-lg text-center text-[12px] italic text-white/45">“{p.transcript}”</p>
        )}
      </div>
    </div>
  );
}
