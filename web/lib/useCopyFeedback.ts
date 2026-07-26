"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * "copy → ✓ copied → back" with a timer that is actually cleaned up.
 *
 * Nine call sites hand-rolled `setTimeout(() => setCopied(null), 1500)` with no
 * ref and no unmount clear, so navigating away during the window fired a
 * setState on an unmounted component. `characters.ts` had the one correct
 * implementation (timer in a ref, cleared before re-arming AND on unmount);
 * this is that, shared.
 *
 * The label also tells the truth: a clipboard write can be denied (permission,
 * insecure context), and reporting "copied" anyway is the failure mode this
 * codebase's honesty rule exists to prevent.
 */
export function useCopyFeedback<K extends string = string>(resetMs = 1500) {
  const [copied, setCopied] = useState<K | null>(null);
  const [failed, setFailed] = useState<K | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  const copy = useCallback(async (text: string, key: K = "" as K) => {
    clear();
    try {
      await navigator.clipboard.writeText(text);
      setFailed(null);
      setCopied(key);
    } catch {
      setCopied(null);
      setFailed(key);
    }
    timer.current = setTimeout(() => { setCopied(null); setFailed(null); }, resetMs);
  }, [clear, resetMs]);

  /** Drop the indicator immediately — for when the thing being copied changes
   *  (a different snippet tab, a new key) and the old "✓ copied" would lie. */
  const reset = useCallback(() => {
    clear();
    setCopied(null);
    setFailed(null);
  }, [clear]);

  useEffect(() => clear, [clear]);

  return { copy, copied, failed, reset };
}
