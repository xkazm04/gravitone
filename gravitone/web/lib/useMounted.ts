"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A ref that goes false on unmount, for guarding setState after an await.
 *
 * The codebase already had this idiom in three spellings (`alive`, `cancelled`,
 * `stopped`) scoped to individual effects — but every data hook's `refresh()`
 * skipped it, so navigating away mid-fetch updated a dead hook. One name, one
 * import.
 *
 *   const mounted = useMounted();
 *   const data = await fetchThing();
 *   if (!mounted.current) return;
 */
export function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;      // re-arm: StrictMode runs effects twice
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}

/**
 * True only once the component is running in the BROWSER — the guard a portal
 * needs before touching `document`.
 *
 * This is deliberately NOT useMounted: that ref is `true` from the first render
 * (server included) because its job is to catch unmount during an await. Using
 * it as a portal guard would render `createPortal(document.body)` during SSR.
 * Three components hand-rolled this same two-liner (EmotionPicker,
 * SecretReveal, GuidedRecorder); one name, one import.
 */
export function useClientReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}
