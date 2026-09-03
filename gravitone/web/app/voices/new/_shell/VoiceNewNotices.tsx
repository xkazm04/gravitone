"use client";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { POLLING_PHASES, type Phase } from "../_state/machine";
import type { useBackpressure } from "../_state/useBackpressure";
import type { Pending } from "../_state/useIngestActions";
import VoiceNewBusyNotice from "./VoiceNewBusyNotice";

/**
 * Everything the flow says at page level, above whichever stage is on screen:
 * the rose failure, the amber backpressure, the degraded poller and a clip the
 * browser would not play. Each is its own fact and none of them replaces
 * another.
 */
export default function VoiceNewNotices({
  error, busy, pending, retryBusy, pollStalled, phase, watching, clipRefusal,
}: {
  error: string | null;
  busy: ReturnType<typeof useBackpressure>;
  pending: Pending;
  retryBusy: () => void;
  pollStalled: boolean;
  phase: Phase;
  watching: boolean;
  clipRefusal: string | null;
}) {
  return (
    <>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {/* Backpressure, in the palette the repo reserves for recoverable:
          nothing failed, the queue is full. The retry waits out the backoff
          window, because retrying inside it only adds another rejection. */}
      {busy.notice && (
        <VoiceNewBusyNotice
          busyNotice={busy.notice}
          retryIn={busy.retryIn}
          pending={pending}
          retryBusy={retryBusy}
        />
      )}
      {pollStalled && (POLLING_PHASES.has(phase) || watching) && (
        <ErrorBanner severity="warning">
          {watching
            // Nothing is running to keep running: what is at stake here is
            // that we cannot tell whether the session is still there, and a
            // commit against a session that has gone will fail.
            ? "connection to the studio is degraded — retrying. Until it is back we can't tell whether this scan session is still open."
            : "connection to the studio is degraded — retrying. Your job keeps running server-side."}
        </ErrorBanner>
      )}
      {/* A clip that would not play, in the service's own words. The <audio>
          element never sees the refusal body, so the sentence is fetched from
          the proxy after the failure — see _state/failures#assetRefusal. */}
      {clipRefusal && (
        <ErrorBanner severity="warning">
          that clip wouldn&apos;t play — {clipRefusal}
        </ErrorBanner>
      )}
    </>
  );
}
