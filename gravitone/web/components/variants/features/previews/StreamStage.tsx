"use client";

import { motion } from "framer-motion";
import { Caption, Draw, HAIR, Stage, Tag, accentVar, pop } from "./illus";
import { Wave } from "./shared";

/*
 * stream · STAGE — a conveyor, and a tray that waits.
 *
 * Upstage left is the renderer; downstage right is the speaker; between them
 * runs one rail. Sentences leave the renderer ONE AT A TIME and cross it, and
 * the scene is deliberately caught mid-traverse: sentence 1 is already at the
 * speaker and sounding, sentence 2 is out on the rail, sentence 3 is still in
 * the renderer with its slot lit. Three sentences in three different states, in
 * one frame, is the claim — an emptied slot behind a tile is what proves the
 * audio left before the render finished.
 *
 * The lower lane is mp3. It has the same tiles, the same rail and the same
 * destination, and nothing on it has moved: the format cannot be transcoded
 * incrementally, so the tray only leaves when it is full. It is drawn at full
 * weight rather than as a footnote — the header X-Stream-Fallback exists
 * precisely so this case cannot masquerade as a stream that took its time.
 */

const SENTENCES = [
  "The rain had not stopped since Tuesday.",
  "She counted the tiles anyway.",
  "Forty-one, then the crack.",
];

/** A sentence, as a thing that can be carried. */
function Tile({
  n,
  text,
  dim = false,
  textMax = "max-w-[124px]",
}: {
  n: number;
  text: string;
  dim?: boolean;
  /** The tray carries three of these side by side, so its tiles are narrower. */
  textMax?: string;
}) {
  const cyan = accentVar("cyan");
  return (
    <span
      className={`font-jetbrains flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 py-1 text-[10px] ${
        dim ? "text-white/40" : "text-cyan-100"
      }`}
      style={{
        borderColor: dim
          ? "rgba(255,255,255,0.14)"
          : `color-mix(in srgb, ${cyan} 42%, transparent)`,
        background: dim ? "rgba(255,255,255,0.03)" : `color-mix(in srgb, ${cyan} 12%, transparent)`,
      }}
    >
      <span className="opacity-50">{n}</span>
      <span className={`${textMax} truncate`}>{text}</span>
    </span>
  );
}

export default function StreamStage({ still }: { still: boolean }) {
  const cyan = accentVar("cyan");

  return (
    <div>
      <Stage accent="cyan" className="px-4 pb-4 pt-3.5">
        <div className="flex items-center justify-between gap-2 pb-2.5">
          <span className="font-jetbrains text-[10px] uppercase tracking-[0.14em] text-white/35">
            post /v1/text-to-speech/alba/stream
          </span>
          <Tag accent="cyan" delay={0.15} still={still}>
            wav_22050
          </Tag>
        </div>

        {/* THE CONVEYOR. */}
        <div className="relative h-[128px]">
          <svg
            viewBox="0 0 600 128"
            className="absolute inset-0 h-full w-full"
            preserveAspectRatio="none"
            aria-hidden
          >
            <Draw d="M186 64 H516" delay={0.35} duration={0.6} stroke={HAIR} width={1.5} still={still} />
          </svg>

          {/* UPSTAGE LEFT — the renderer, and the slots the sentences left. */}
          <motion.div
            {...pop(0.1, still)}
            className="absolute left-0 top-1/2 w-[30%] -translate-y-1/2 rounded-xl border border-white/12 bg-white/[0.03] px-2 py-2"
          >
            <span className="font-jetbrains text-[9px] uppercase tracking-[0.14em] text-white/35">
              renderer
            </span>
            <div className="mt-1.5 space-y-1">
              {SENTENCES.map((_, i) => (
                <motion.div
                  key={i}
                  {...pop(0.25 + i * 0.08, still)}
                  className="h-4 rounded-[4px] border"
                  style={
                    i === 2
                      ? {
                          borderColor: `color-mix(in srgb, ${cyan} 45%, transparent)`,
                          background: `color-mix(in srgb, ${cyan} 14%, transparent)`,
                        }
                      : {
                          // Emptied: this sentence has already left the building.
                          borderColor: "rgba(255,255,255,0.10)",
                          borderStyle: "dashed",
                          background: "transparent",
                        }
                  }
                />
              ))}
            </div>
            <div className="mt-1.5 flex justify-end">
              <Tag accent="cyan" delay={1.1} still={still}>
                rendering 3
              </Tag>
            </div>
          </motion.div>

          {/* IN TRANSIT — caught mid-rail, one ahead of the other. */}
          {[
            { i: 0, to: "72%", delay: 0.9 },
            { i: 1, to: "50%", delay: 1.45 },
          ].map(({ i, to, delay }) => (
            <motion.span
              key={i}
              initial={still ? { opacity: 1, left: to } : { opacity: 0, left: "31%" }}
              animate={{ opacity: 1, left: to }}
              transition={still ? undefined : { delay, duration: 0.85, ease: [0.22, 1, 0.36, 1] }}
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
            >
              <Tile n={i + 1} text={SENTENCES[i]} />
            </motion.span>
          ))}

          {/* DOWNSTAGE RIGHT — the speaker, already sounding. */}
          <motion.div
            {...pop(1.7, still)}
            className="absolute right-0 top-1/2 -translate-y-1/2 rounded-xl border px-2.5 py-2"
            style={{
              borderColor: `color-mix(in srgb, ${cyan} 45%, transparent)`,
              background: `color-mix(in srgb, ${cyan} 9%, transparent)`,
              boxShadow: `0 16px 40px -28px ${cyan}`,
            }}
          >
            <Wave bars={8} className="h-6 w-14" accent="cyan" delay={1.85} still={still} />
            <div className="mt-1.5">
              <Tag accent="cyan" delay={1.95} still={still}>
                playing 1
              </Tag>
            </div>
          </motion.div>
        </div>

        {/* THE LOWER LANE — same rail, nothing on it. */}
        <motion.div
          {...pop(2.2, still)}
          className="mt-1 flex items-center gap-2 rounded-xl border border-dashed px-2.5 py-2"
          style={{ borderColor: `color-mix(in srgb, ${accentVar("violet")} 32%, transparent)` }}
        >
          <span className="font-jetbrains shrink-0 text-[10px] uppercase tracking-[0.14em] text-white/35">
            mp3
          </span>
          {/* The tray: all three, still here. */}
          <span className="flex min-w-0 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1">
            {SENTENCES.map((s, i) => (
              <motion.span key={s} {...pop(2.35 + i * 0.07, still)} className="inline-flex">
                <Tile n={i + 1} text={s} dim textMax="max-w-[62px]" />
              </motion.span>
            ))}
          </span>
          <span className="ml-auto shrink-0">
            <Tag accent="violet" delay={2.6} still={still}>
              x-stream-fallback · leaves full
            </Tag>
          </span>
        </motion.div>
      </Stage>

      <Caption delay={2.8} still={still}>
        Sentence one is sounding while sentence three is still being made — and the
        format that cannot leave early says so in a header rather than looking like
        a slow stream.
      </Caption>
    </div>
  );
}
