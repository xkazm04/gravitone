// What the reading LOOKS like on the page it is reading: the hue it tints the
// frame with, and the one attribute + rule that mark the block being spoken.

/** Hue per section role, so the frame tints as the reading moves through the
 *  page. Values are the emotion hues from lib/emotions, restated as a narration
 *  concern rather than imported — this is "how the dock feels", not the scale. */
export const ROLE_HUE: Record<string, number> = {
  hero: 20, stat: 48, voice: 48, feature: 200, switch: 200, cta: 20,
  benchmark: 170, methodology: 170,
};

export const HIGHLIGHT_ATTR = "data-gt-narrating";

/** The one global rule this component owns: what a narrated block looks like.
 *  Scoped entirely to an attribute nothing else writes. */
export const HIGHLIGHT_CSS = `
[${HIGHLIGHT_ATTR}] {
  border-radius: 22px;
  outline: 1px solid hsl(var(--gt-narr-hue, 190) 90% 65% / calc(0.25 + var(--gt-level, 0) * 0.45));
  outline-offset: 10px;
  box-shadow: 0 0 60px -20px hsl(var(--gt-narr-hue, 190) 90% 60% / 0.5);
  transition: outline-color 400ms var(--gt-ease), box-shadow 400ms var(--gt-ease);
}`;

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
