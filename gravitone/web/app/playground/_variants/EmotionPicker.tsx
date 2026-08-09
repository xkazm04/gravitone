"use client";

// Emotion Wheel — reborn as a Playground helper. A radial picker (the Wheel
// direction from the voices round) that DIRECTS the composer's current selection
// — it hands the id to `onPick`, which places a region in the one emotion model
// (shared.applyEmotion); nothing here writes markup. Each spoke carries the
// emotion's icon (lib/emotions::EMOTION_ICONS); emotions the
// active Character lacks are dimmed and marked as substituted (the backend
// picks the nearest recorded emotion first, and only then baseline).

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { emotionMeta } from "@/lib/emotions";
import { useClientReady } from "@/lib/useMounted";
import { EASE } from "@/components/ui/tokens";
import EmotionSpoke from "./EmotionSpoke";
import { useEmotionWheelKeys } from "./useEmotionWheelKeys";
import { COMPACT_BELOW, MAX_BOX, SPOKE_REACH, wheelBox } from "./emotionWheel";

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
  // (that was why it rendered below the page sections).
  const ready = useClientReady();
  const { panelRef, spokes } = useEmotionWheelKeys({ open, ready, onClose });
  // The spoke the hub is describing. Availability used to be conveyed by
  // dimming plus a `title`, and a tooltip is invisible on touch and silent to a
  // screen reader — the hub says it in words instead.
  const [active, setActive] = useState<number | null>(null);
  // Rendered client-side only (see `ready`), so measuring the viewport here
  // cannot desynchronise a server render.
  const [box, setBox] = useState(MAX_BOX);
  const compact = box < COMPACT_BELOW;
  const radius = Math.round(box / 2 - (compact ? SPOKE_REACH.compact : SPOKE_REACH.full));

  useEffect(() => {
    if (!open || !ready) return;
    const measure = () => setBox(wheelBox(window.innerWidth, window.innerHeight));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, ready]);

  useEffect(() => { if (!open) setActive(null); }, [open]);

  if (!ready) return null;

  /** What the hub is describing right now — the spoke under the pointer or
   *  under focus, whichever moved last. */
  const hubId = active !== null ? scale[active] : undefined;
  const hub = hubId
    ? { id: hubId, label: emotionMeta(hubId).label, has: available.includes(hubId) }
    : null;

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
            ref={panelRef}
            tabIndex={-1}
            className="glass-panel relative max-h-[100dvh] overflow-y-auto rounded-3xl p-4 focus:outline-none sm:p-8"
          >
            <div className="mb-2 text-center">
              <div className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">insert emotion</div>
              <div className="font-instrument mt-1 text-xl text-white">Tag your selection</div>
            </div>

            <div className="relative grid place-items-center" data-testid="wheel" style={{ height: box, width: box }}>
              {/* orbit ring. A sized div rather than a fixed 440-unit viewBox,
                  because the ring has to be the radius the spokes actually use. */}
              <div
                aria-hidden
                className="pointer-events-none absolute rounded-full border border-white/[0.07]"
                style={{ height: radius * 2, width: radius * 2 }}
              />

              {/* The hub. It used to say the Character's name and "pick a mood"
                  and nothing else; now it is where a spoke's AVAILABILITY is
                  spelled out, because a `title` tooltip is invisible on touch
                  and silent to a screen reader. */}
              <div
                className="z-10 grid place-items-center rounded-full border border-white/15 bg-[#0b0e15]/90 px-2 text-center"
                style={{ height: compact ? 108 : 128, width: compact ? 108 : 128 }}
              >
                <div>
                  <div className="font-instrument text-base leading-tight text-white sm:text-lg">{characterName}</div>
                  {hub ? (
                    <div className="font-jetbrains mt-1 text-[10px] leading-snug text-white/75">
                      {hub.label}
                      <span className={hub.has ? "block text-emerald-300/90" : "block text-amber-300/90"}>
                        {hub.has ? "available" : "not recorded"}
                      </span>
                    </div>
                  ) : (
                    <div className="font-jetbrains mt-1 text-[10px] uppercase tracking-widest text-white/60">pick a mood</div>
                  )}
                </div>
              </div>

              {scale.map((id, i) => (
                <EmotionSpoke
                  key={id}
                  id={id}
                  index={i}
                  count={scale.length}
                  radius={radius}
                  compact={compact}
                  has={available.includes(id)}
                  characterId={characterId}
                  characterName={characterName}
                  onPick={onPick}
                  onClose={onClose}
                  setActive={setActive}
                  spokeRef={(el: HTMLButtonElement | null) => { spokes.current[i] = el; }}
                />
              ))}
            </div>

            {/* Compact loses the per-spoke record links, so the one for the
                spoke in hand is offered here rather than lost. */}
            {compact && hub && !hub.has && (
              <p className="text-center">
                <Link
                  href={`/voices/${encodeURIComponent(characterId)}?record=${hub.id}`}
                  onClick={onClose}
                  className="font-jetbrains inline-block px-3 py-2 text-[12px] text-amber-300/90 underline-offset-2 hover:underline"
                >
                  record {hub.label} for {characterName} →
                </Link>
              </p>
            )}

            <p className="font-jetbrains mt-3 text-center text-[12px] leading-relaxed text-white/60">
              Directs your selected words — <span className="text-cyan-300">Baseline</span> clears the
              direction instead
              <span className="mt-1 block text-white/40">arrow keys walk the wheel · enter applies · esc closes</span>
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
