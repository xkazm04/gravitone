// The console's render estimate, as a pure function of its three inputs.
// Extracted from PlaygroundConsole so the rule — and every sentence it can
// produce — is readable and testable next to nothing else.

/** What the console may honestly say about the wait. */
// estSec is estimated AUDIO seconds; what the user waits for is COMPUTE
// seconds. The bridge is the realtime factor (audio produced per second of
// compute): their own last render first (it measured THIS box under THIS
// load), the engine's live average second. With neither, there is nothing
// honest to estimate from and the UI says exactly that rather than inventing
// a number or drawing a progress bar for work whose progress is unobservable.
export function renderEstimate({ estAudioSec, lastRtf, liveRtfRaw, metricsUnavailable }: {
  estAudioSec: number;
  /** The realtime factor of the user's own last render, when there is one this
   *  build is allowed to calibrate from. */
  lastRtf: number | undefined;
  /** The engine's live average, exactly as the health metrics reported it —
   *  null when the metric is not visible to this studio. */
  liveRtfRaw: number | null;
  metricsUnavailable: boolean;
}): { etaSec: number | null; etaBasisLabel: string; noEtaLabel: string } {
  const liveRtf = liveRtfRaw !== null && liveRtfRaw > 0 ? liveRtfRaw : undefined;
  const rtfBasis = lastRtf ?? liveRtf;
  const etaSec = rtfBasis ? Math.max(1, Math.round(estAudioSec / rtfBasis)) : null;
  const etaBasisLabel = lastRtf
    ? `your last render ran at ${lastRtf}× realtime`
    : liveRtf ? `the engine is averaging ${liveRtf}× realtime` : "";
  // With no basis there is no estimate — but WHY there is none is the honest
  // part. "The first render calibrates one" is untrue when the engine's own
  // average exists and is merely invisible to this studio.
  const noEtaLabel = metricsUnavailable
    ? "No estimate yet — the engine's realtime factor is not visible to this studio, and no render here has calibrated one."
    : "No estimate yet — the first render on this machine is what calibrates one.";
  return { etaSec, etaBasisLabel, noEtaLabel };
}
