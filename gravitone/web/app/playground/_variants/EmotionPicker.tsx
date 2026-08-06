"use client";

// Emotion Wheel — reborn as a Playground helper. A radial picker (the Wheel
// direction from the voices round) that DIRECTS the composer's current selection
// — it hands the id to `onPick`, which places a region in the one emotion model
// (shared.applyEmotion); nothing here writes markup. Each spoke is the emotion's
// generated art; emotions the
// active Character lacks are dimmed and marked as substituted (the backend
// picks the nearest recorded emotion first, and only then baseline).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import EmotionArt from "@/components/ui/EmotionArt";
import { EMOTION_IDS, emotionMeta } from "@/lib/emotions";
import { useClientReady } from "@/lib/useMounted";
import { EASE } from "@/components/ui/tokens";

/** The wheel at its most generous — the size it was hard-coded at, now a
 *  ceiling rather than a demand. */
const MAX_BOX = 440;
/** Below this the wheel is still a wheel, but the spokes shrink to a 44px
 *  touch target and their status lines move to the hub (which is the only
 *  place there is room for a sentence). */
const COMPACT_BELOW = 380;
/** Half a spoke, so the ring can be inset far enough that no spoke crosses the
 *  panel edge. Compact spokes are w-16 with a 44px disc; full ones are w-24
 *  with a 64px disc, plus a label line under each. */
const SPOKE_REACH = { compact: 34, full: 52 };

/**
 * How big the wheel can be right now.
 *
 * It used to be `h-[440px] w-[440px]` with `R = 150`, which overflows every
 * phone in existence — the control that teaches this product's best idea was
 * unusable on the device most people would first meet it on. The box is
 * measured against BOTH axes because a wheel that fits the width and runs off
 * the bottom is equally unreachable.
 */
function wheelBox(w: number, h: number): number {
  return Math.max(240, Math.min(MAX_BOX, w - 64, h - 240));
}

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
  const panelRef = useRef<HTMLDivElement>(null);
  // Where focus came from, so closing puts it back — a keyboard user who opens
  // the wheel from the composer must not be returned to the top of the page.
  const opener = useRef<HTMLElement | null>(null);
  // Every spoke, in ring order, so an arrow key can walk them. Plain buttons
  // with NO arrow handling meant the only way around the wheel was Tab, which
  // has nothing to do with the shape the user is looking at.
  const spokes = useRef<Array<HTMLButtonElement | null>>([]);
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

  // This claimed role="dialog" aria-modal="true" while leaving focus outside
  // it: Tab walked the page behind the overlay, and a screen-reader user was
  // told they were in a modal that did not contain them.
  useEffect(() => {
    // `ready` is a dependency because the portal (and therefore the panel this
    // focuses) does not exist on the first render.
    if (!open || !ready) return;
    opener.current = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((el) => !el.hasAttribute("disabled"));
    // Focus the panel itself rather than the first spoke, so the dialog's label
    // is announced before its options.
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }

      // Arrows walk the RING. Enter/Space need no handling — every spoke is a
      // real <button>, so the browser already activates the focused one, and
      // re-implementing that would only add a way for the two paths to
      // disagree. Tab still walks linearly, and the trap below still owns it.
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (step !== 0 || e.key === "Home" || e.key === "End") {
        const ring = spokes.current.filter(Boolean) as HTMLButtonElement[];
        if (ring.length === 0) return;
        e.preventDefault();
        const at = ring.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "Home" ? 0
          : e.key === "End" ? ring.length - 1
          // Focus not on the ring yet (the panel itself has it on open): the
          // first arrow press should land ON the ring, not skip a spoke.
          : at < 0 ? (step === 1 ? 0 : ring.length - 1)
          : (at + step + ring.length) % ring.length;
        ring[next].focus();
        return;
      }

      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const here = document.activeElement;
      // Wrap at both ends — that wrap IS the trap.
      if (e.shiftKey && (here === first || here === panelRef.current)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && here === last) {
        e.preventDefault(); first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Restore focus on close (and on unmount while open).
      opener.current?.focus?.();
    };
  }, [open, ready, onClose]);

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

              {scale.map((id, i) => {
                const e = emotionMeta(id);
                const a = (i / scale.length) * Math.PI * 2 - Math.PI / 2;
                // Rounded because `Math.cos(-PI/2)` is 6e-17, not 0, and an
                // unrounded product renders as `7.4e-15px` — legal CSS that
                // nothing downstream should have to parse.
                const x = Math.round(Math.cos(a) * radius);
                const y = Math.round(Math.sin(a) * radius);
                const has = available.includes(id);
                const custom = !EMOTION_IDS.includes(id);
                const disc = compact ? 44 : 64; // 44px is the touch-target floor
                // Positioning transform lives on a plain wrapper; the animated
                // button only touches opacity/scale (so framer's transform can't
                // clobber the translate — that was the "all nodes stacked" bug).
                return (
                  <div key={e.id} className="absolute" style={{ transform: `translate(${x}px, ${y}px)` }}>
                    <motion.button
                      ref={(el: HTMLButtonElement | null) => { spokes.current[i] = el; }}
                      initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.35, ease: EASE, delay: i * 0.04 }}
                      onClick={() => { onPick(e.id); onClose(); }}
                      onFocus={() => setActive(i)}
                      onBlur={() => setActive((v) => (v === i ? null : v))}
                      onMouseEnter={() => setActive(i)}
                      onMouseLeave={() => setActive((v) => (v === i ? null : v))}
                      // The accessible NAME carries availability and its
                      // consequence. It used to carry neither: the art's alt
                      // text plus the label, with the whole substitution story
                      // in a `title` no touch or screen-reader user ever meets.
                      aria-label={has
                        ? `${e.label} — available`
                        : `${e.label} — not recorded; the nearest recorded emotion is used, then baseline`}
                      title={has ? `${e.label} — available` : `${e.label} — not recorded: the nearest recorded emotion is used, then baseline`}
                      className="group flex cursor-pointer flex-col items-center"
                      style={{ width: compact ? 64 : 96 }}
                    >
                      <span
                        className="relative grid place-items-center overflow-hidden rounded-full border bg-black/60 transition-transform duration-300 group-hover:scale-110"
                        style={{
                          height: disc,
                          width: disc,
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
                          size={disc - 8}
                          dim={!has}
                          className={has ? "transition duration-300 [filter:saturate(.7)_brightness(.9)] group-hover:[filter:saturate(1.5)_brightness(1.3)]" : ""}
                        />
                        {/* A GLYPH, not a tint: availability that survives both
                            a colourblind reader and a monochrome screenshot,
                            and the only availability mark that fits a compact
                            spoke at all. */}
                        <span
                          aria-hidden
                          className={`font-jetbrains absolute right-0 bottom-0 grid h-4 w-4 place-items-center rounded-full border text-[9px] leading-none ${has ? "border-emerald-400/50 bg-emerald-500/25 text-emerald-100" : "border-amber-400/50 bg-amber-500/25 text-amber-100"}`}
                        >
                          {has ? "✓" : "+"}
                        </span>
                      </span>
                      <span className="font-jetbrains mt-1.5 text-[11px] font-medium text-white transition group-hover:text-cyan-200 sm:text-[12px]">{e.label}</span>
                    </motion.button>
                    {/* status line lives OUTSIDE the button so a missing
                        emotion can deep-link into the guided recorder. It is the
                        first thing dropped when the wheel is compact — the hub
                        says the same thing, with room for the sentence. */}
                    {!compact && (has ? (
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
                    ))}
                  </div>
                );
              })}
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
