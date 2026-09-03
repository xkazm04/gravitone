"use client";

import { useRef, useState, type Dispatch } from "react";
import { useMounted } from "@/lib/useMounted";
import type { CastSelection } from "./cast";
import { cancelIngest } from "./failures";
import type { Action } from "./machine";

/**
 * The two ways OUT of a job — tear this one down, or leave it and take a fresh
 * recording — and the one state that says a teardown did not happen.
 *
 * The ephemeral input setters are passed in rather than owned here: they belong
 * to the page (see machine.ts on why that state is not in the state graph), and
 * a reset is precisely the moment every one of them has to be re-taken.
 */
export function useIngestReset(opts: {
  jobId: string | null;
  dispatch: Dispatch<Action>;
  setFile: (f: File | null) => void;
  setKeepCorpus: (v: boolean) => void;
  setCastSel: (s: CastSelection) => void;
  setConsented: (v: boolean) => void;
  clearBusy: () => void;
  clearClipRefusal: () => void;
}) {
  const {
    jobId, dispatch, setFile, setKeepCorpus, setCastSel, setConsented,
    clearBusy, clearClipRefusal,
  } = opts;
  const mounted = useMounted();
  // A DELETE that did NOT tear the job down. Load-bearing: while this is set,
  // the flow has not been reset, because resetting would tell the user the
  // session is gone while the backend may still be cloning into their roster.
  const [cancelFailed, setCancelFailed] = useState<string | null>(null);
  const cancelling = useRef(false); // atomic gate — Cancel is double-clickable

  async function cancelCommit() {
    // DELETE tears down the whole job server-side (workdir included), so the
    // review ledger is gone too — the only honest place to land is upload.
    //
    // But ONLY if the DELETE actually happened. This used to swallow its
    // failure and start over unconditionally: the user was shown a fresh
    // dropzone, told nothing, while the backend kept cloning voices into their
    // roster. A failed cancel now stays on this screen and says what is still
    // true (the poller keeps running, so a commit that finishes anyway still
    // lands on the complete screen).
    if (!jobId || cancelling.current) return;
    cancelling.current = true;
    setCancelFailed(null);
    try {
      const outcome = await cancelIngest(jobId);
      if (!mounted.current) return;
      if (!outcome.ok) { setCancelFailed(outcome.detail); return; }
      startOver();
    } finally {
      cancelling.current = false;
    }
  }

  function startOver() {
    setFile(null); clearBusy(); setKeepCorpus(false);
    setCancelFailed(null); clearClipRefusal(); setCastSel({}); setConsented(false);
    dispatch({ type: "RESET", kind: "start-over" });
  }

  function scanAnother() {
    // The retention opt-in is re-taken per recording, never inherited: it is a
    // decision about THIS audio, and carrying it forward would keep a second
    // recording on the box on the strength of a tick about the first.
    setFile(null); clearBusy(); setKeepCorpus(false);
    setCancelFailed(null); clearClipRefusal(); setCastSel({}); setConsented(false);
    dispatch({ type: "RESET", kind: "scan-another" });
  }

  return { cancelFailed, cancelCommit, startOver, scanAnother };
}
