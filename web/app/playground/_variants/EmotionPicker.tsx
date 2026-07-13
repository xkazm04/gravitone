"use client";

// Emotion Wheel — reborn as a Playground helper. A radial picker (the Wheel
// direction from the voices round) that inserts an [emotion]…[/emotion] metatag
// into the composer. Each spoke is the emotion's generated art; emotions the
// active Character lacks are dimmed and marked "→ baseline".

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import EmotionArt from "@/components/ui/EmotionArt";
import { EMOTION_IDS, emotionMeta } from "@/lib/emotions";
import { EASE } from "@/components/ui/tokens";

const R = 150;

export default function EmotionPicker({
  open,
  onClose,
  onPick,
  available,
  scale,
  characterName,
  characterId,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (emotion: string) => void;
  available: string[];
  scale: string[]; // the character's palette — base scale + custom slots
  characterName: string;
  characterId: string;
}) {
  // Portal to <body> so the modal escapes AppFrame's overflow/stacking context
  // (that was why it rendered below the page sections). Close on Escape.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] grid place-items-center bg-black/75 p-4 backdrop-blur-md"
          onClick={onClose}
          role="dialog" aria-modal="true" aria-label="Insert emotion"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.28, ease: EASE }}
            onClick={(e) => e.stopPropagation()}
            className="glass-panel relative rounded-3xl p-8"
          >
            <div className="mb-2 text-center">
              <div className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">insert emotion</div>
              <div className="font-instrument mt-1 text-xl text-white">Tag your selection</div>
            </div>

            <div className="relative grid h-[440px] w-[440px] place-items-center">
              {/* orbit ring */}
              <svg className="pointer-events-none absolute inset-0" viewBox="0 0 440 440" aria-hidden>
                <circle cx="220" cy="220" r={R} fill="none" stroke="rgba(255,255,255,0.07)" />
              </svg>

              {/* centre */}
              <div className="z-10 grid h-28 w-28 place-items-center rounded-full border border-white/15 bg-[#0b0e15]/90 text-center">
                <div>
                  <div className="font-instrument text-lg leading-tight text-white">{characterName}</div>
                  <div className="font-jetbrains mt-1 text-[11px] uppercase tracking-widest text-white/60">pick a mood</div>
                </div>
              </div>

              {scale.map((id, i) => {
                const e = emotionMeta(id);
                const a = (i / scale.length) * Math.PI * 2 - Math.PI / 2;
                const x = Math.cos(a) * R;
                const y = Math.sin(a) * R;
                const has = available.includes(id);
                const custom = !EMOTION_IDS.includes(id);
                // Positioning transform lives on a plain wrapper; the animated
                // button only touches opacity/scale (so framer's transform can't
                // clobber the translate — that was the "all nodes stacked" bug).
                return (
                  <div key={e.id} className="absolute" style={{ transform: `translate(${x}px, ${y}px)` }}>
                    <motion.button
                      initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.35, ease: EASE, delay: i * 0.04 }}
                      onClick={() => { onPick(e.id); onClose(); }}
                      title={has ? `${e.label} — available` : `${e.label} — not recorded, falls back to baseline`}
                      className="group flex w-24 cursor-pointer flex-col items-center"
                    >
                      <span
                        className="relative grid h-16 w-16 place-items-center overflow-hidden rounded-full border bg-black/60 transition-transform duration-300 group-hover:scale-110"
                        style={{
                          borderColor: has ? `hsl(${e.hue} 85% 60%)` : "rgba(255,255,255,0.15)",
                          borderStyle: custom ? "dashed" : "solid", // custom slots read as bespoke
                        }}
                      >
                        {/* hue glow — fades in on hover, out on leave */}
                        <span
                          aria-hidden
                          className="pointer-events-none absolute inset-0 rounded-full opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                          style={{ boxShadow: `0 0 26px hsl(${e.hue} 90% 60% / .65), inset 0 0 14px hsl(${e.hue} 90% 60% / .35)` }}
                        />
                        {/* image dimmed at rest, brightens + saturates toward the emotion colour on hover */}
                        <EmotionArt
                          emotion={e.id}
                          size={56}
                          dim={!has}
                          className={has ? "transition duration-300 [filter:saturate(.7)_brightness(.9)] group-hover:[filter:saturate(1.5)_brightness(1.3)]" : ""}
                        />
                      </span>
                      <span className="font-jetbrains mt-2 text-[12px] font-medium text-white transition group-hover:text-cyan-200">{e.label}</span>
                    </motion.button>
                    {/* status line lives OUTSIDE the button so a missing
                        emotion can deep-link into the guided recorder */}
                    {has ? (
                      <span className="font-jetbrains block w-24 text-center text-[11px]" style={{ color: "hsl(160 60% 60%)" }}>
                        available
                      </span>
                    ) : (
                      <Link
                        href={`/voices/${encodeURIComponent(characterId)}?record=${e.id}`}
                        onClick={onClose}
                        title={`${characterName} has no ${e.label} voice yet — record it now`}
                        className="font-jetbrains block w-24 text-center text-[11px] text-amber-300/80 underline-offset-2 transition hover:text-amber-200 hover:underline"
                      >
                        record →
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="font-jetbrains mt-3 text-center text-[12px] text-white/60">
              Wraps your selected text in <span className="text-cyan-300">[emotion]…[/emotion]</span>
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
