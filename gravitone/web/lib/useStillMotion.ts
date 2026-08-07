"use client";

import { useSyncExternalStore } from "react";

/*
 * `prefers-reduced-motion`, read as external state React subscribes to rather
 * than state an effect mirrors.
 *
 * framer's own `useReducedMotion` cannot be used by anything server-rendered.
 * The server has no media query, so the hook answers "motion is fine" during
 * SSR and the truth only after mount — and any component that branches its
 * MARKUP, or its initial inline styles, on that answer hydrates against HTML it
 * did not produce. React responds by throwing the whole tree away and
 * re-rendering the page on the client: the most work possible for precisely the
 * visitors who asked for less. The landing page is statically prerendered
 * (`next build`), so this is not a theoretical risk here — it is the default.
 *
 * `useSyncExternalStore` fixes it at the root: React uses `getServerSnapshot`
 * for the hydrating render too, so the first client paint always matches the
 * server and the real preference arrives on the very next commit.
 *
 * THE RULE: gate an `animate` prop, never drop an element. Then that second
 * commit is a stopped animation rather than a reflow.
 *
 * Note this is a belt-and-braces hook: globals.css already kills every CSS
 * animation and transition under `prefers-reduced-motion: reduce`. What it
 * cannot reach is framer-motion (which writes inline transforms) and recharts
 * (`isAnimationActive`) — which is exactly what this hook is for.
 */
const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

const isReduced = () => window.matchMedia(QUERY).matches;
// The server cannot know, and guessing "reduced" would ship a still page to
// everyone for one frame. Guess "motion", then correct.
const serverSnapshot = () => false;

/** True when the visitor has asked for reduced motion. Safe to SSR. */
export function useStillMotion(): boolean {
  return useSyncExternalStore(subscribe, isReduced, serverSnapshot);
}
