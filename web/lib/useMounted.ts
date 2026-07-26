"use client";

import { useEffect, useRef } from "react";

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
