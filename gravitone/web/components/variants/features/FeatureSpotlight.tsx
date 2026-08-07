"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { FEATURES } from "@/lib/content";
import { useStillMotion } from "@/lib/useStillMotion";
import {
  PREVIEWS,
  VARIANTS,
  previewBody,
  type PreviewKey,
  type PreviewVariant,
} from "./previews";

/*
 * The frame around a feature preview — a plain click-opened modal.
 *
 * The hover-peek/pin split was retired by owner call: one gesture (click or
 * Enter opens, Escape / scrim / the button closes) beats two overlapping ones.
 *
 * The body must be designed to FIT — `.scroll-y` on the frame is the safety
 * net for short viewports, not a licence for tall content.
 *
 * Reduced motion is read here, once, and passed down to the body — so every
 * diagram resolves the preference identically, and via useStillMotion rather
 * than framer's hook, which cannot be trusted by anything the server rendered.
 * The rule holds inside the previews too: gate the animation, keep the element.
 */
export type { PreviewKey };

/* PROTOTYPING SCAFFOLD (throwaway — deleted at consolidation together with
 * PREVIEWS.bodies). Module-level so flipping between cards keeps the chosen
 * lens; default `steps`, so nothing changes on load. */
let chosenVariant: PreviewVariant = "steps";

export function FeatureSpotlight({
  preview,
  onClose,
}: {
  preview: PreviewKey | null;
  onClose: () => void;
}) {
  const still = useStillMotion();
  const [variant, setVariant] = useState<PreviewVariant>(chosenVariant);
  const def = preview ? PREVIEWS[preview] : null;
  const feature = preview ? FEATURES.find((f) => f.key === preview) : null;
  const Body = preview ? previewBody(preview, variant) : null;

  return (
    <AnimatePresence>
      {def && preview && feature && Body && (
        <motion.div
          key="spotlight"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[60] grid place-items-center p-4 sm:p-8"
        >
          {/* Dimmed rather than blurred: a backdrop-filter over the whole page
              costs a full-screen composite on every frame of the fade, and the
              cards underneath are already glass. */}
          <div className="absolute inset-0 bg-[var(--gt-ink)]/70" onClick={onClose} aria-hidden />
          <motion.div
            initial={still ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={still ? { duration: 0.15 } : { type: "spring", bounce: 0.24, duration: 0.5 }}
            role="dialog"
            aria-modal
            aria-label={feature.title}
            className="scroll-y glass-panel relative max-h-[85vh] w-full max-w-2xl rounded-3xl p-6 sm:p-7"
          >
            <div className="flex items-start justify-between gap-3 border-b border-white/8 pb-4">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-cyan-400/25 bg-cyan-400/10">
                  <def.icon className="h-4 w-4 text-cyan-200" />
                </span>
                <h3 className="font-instrument text-xl leading-tight text-white">{feature.title}</h3>
              </div>
              {/* PROTOTYPING SCAFFOLD — the lens switcher. Throwaway. */}
              <div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-full border border-white/10 p-0.5">
                {VARIANTS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      chosenVariant = v;
                      setVariant(v);
                    }}
                    aria-pressed={v === variant}
                    className={`font-jetbrains cursor-pointer rounded-full px-2 py-1 text-[10px] uppercase tracking-widest transition ${
                      v === variant ? "bg-white/10 text-cyan-200" : "text-white/35 hover:text-white/70"
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-full border border-white/12 text-white/70 transition hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            {/* Keyed remount → every peek replays the choreography from the top.
                Without it, reopening the same card would show a diagram already
                finished, which is the one thing an animated explanation cannot
                afford. */}
            <div className="pt-5" key={`${preview}:${variant}`}>
              <Body still={still} />
            </div>
            <p className="font-jetbrains mt-5 text-right text-[11px] uppercase tracking-widest text-white/35">
              esc to close
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
