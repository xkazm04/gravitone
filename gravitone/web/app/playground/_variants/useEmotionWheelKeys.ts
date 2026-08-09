"use client";

// The wheel's keyboard contract: a real focus trap, arrow keys that walk the
// RING rather than the tab order, and focus handed back to whoever opened it.
// It owns the two refs those rules are written against, so the picker can only
// use them the way the trap expects.

import { useEffect, useRef } from "react";

export function useEmotionWheelKeys({ open, ready, onClose }: {
  open: boolean;
  /** The portal is mounted (client-only), so the panel this focuses exists. */
  ready: boolean;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Where focus came from, so closing puts it back — a keyboard user who opens
  // the wheel from the composer must not be returned to the top of the page.
  const opener = useRef<HTMLElement | null>(null);
  // Every spoke, in ring order, so an arrow key can walk them. Plain buttons
  // with NO arrow handling meant the only way around the wheel was Tab, which
  // has nothing to do with the shape the user is looking at.
  const spokes = useRef<Array<HTMLButtonElement | null>>([]);

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

  return { panelRef, spokes };
}
