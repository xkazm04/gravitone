"use client";

/*
 * The landing page's spotlight state. A hook rather than a block inside the
 * page body, but it is still the PAGE that owns it — which is the whole point
 * of the note below.
 */

import { useCallback, useEffect, useState } from "react";
import type { PreviewKey } from "./features/previews";

// ── the feature spotlight ──────────────────────────────────────────────────
//
// This state lives here rather than in FeatureGrid because the modal renders
// at the PAGE root: inside the grid it would be a descendant of a card that
// has `overflow-hidden` (for the corner wash) and a hover transform, either of
// which would clip or re-anchor a fixed overlay.
//
// One state: a card click (or Enter) opens the modal; Escape, the scrim or
// the close button dismiss it. Hover-peek was retired by owner call.
export function useStudioPreview() {
  const [preview, setPreview] = useState<PreviewKey | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);
  const openPreview = useCallback((key: PreviewKey) => setPreview(key), []);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePreview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, closePreview]);

  return { preview, openPreview, closePreview };
}
