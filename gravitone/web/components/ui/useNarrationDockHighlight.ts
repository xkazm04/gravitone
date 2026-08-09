"use client";

// Everything the reading does OUTSIDE the dock: the block it marks on the page
// and the hue it lends the frame. Both are driven off the same step, so they
// live together — a highlight that disagreed with the tint would be two
// different claims about where the reading is.

import { useEffect } from "react";

import type { NarrationStep } from "@/lib/narratable";
import type { AudioBusApi } from "./AudioBus";
import { HIGHLIGHT_ATTR, ROLE_HUE, prefersReducedMotion } from "./narrationDockHighlight";

export function useNarrationDockHighlight({
  live, step, bus,
}: {
  live: boolean;
  step: NarrationStep | undefined;
  bus: AudioBusApi;
}) {
  // ── the highlight: information, so it survives reduced motion ─────────────
  useEffect(() => {
    if (!live || !step?.block.anchor) return;
    let el: Element | null = null;
    try {
      el = document.querySelector(step.block.anchor);
    } catch {
      el = null; // a selector this browser cannot parse costs the highlight only
    }
    if (!el) return;
    el.setAttribute(HIGHLIGHT_ATTR, "");
    (el as HTMLElement).style.setProperty(
      "--gt-narr-hue", String(ROLE_HUE[step.block.role] ?? 190));
    if (!prefersReducedMotion()) {
      try {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch {
        /* older browsers: no smooth scroll, no problem */
      }
    }
    return () => {
      el?.removeAttribute(HIGHLIGHT_ATTR);
      (el as HTMLElement | null)?.style.removeProperty("--gt-narr-hue");
    };
  }, [live, step?.block.anchor, step?.block.role, step?.blockIndex]);

  // The frame tints with the section being read (contract C4's --gt-hue).
  useEffect(() => {
    if (!live || !step) return;
    bus.setHue(ROLE_HUE[step.block.role] ?? 190);
    return () => bus.setHue(null);
  }, [bus, live, step?.block.role, step]);
}
