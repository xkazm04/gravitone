"use client";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import type { Backpressure } from "../_state/useBackpressure";
import type { Pending } from "../_state/useIngestActions";

export default function VoiceNewBusyNotice({
  busyNotice, retryIn, pending, retryBusy,
}: {
  busyNotice: Backpressure;
  retryIn: number;
  pending: Pending;
  retryBusy: () => void;
}) {
  return (
    <ErrorBanner severity="warning">
      <span className="flex flex-wrap items-center justify-between gap-3">
        <span>
          {busyNotice.detail}.{" "}
          {retryIn > 0
            ? busyNotice.stated
              ? `The backend asked for ${retryIn}s before the next attempt.`
              : `Retry unlocks in ${retryIn}s.`
            : "You can try again now."}
        </span>
        <button
          onClick={retryBusy}
          disabled={pending !== null || retryIn > 0}
          title={retryIn > 0 ? `waiting ${retryIn}s before retrying` : "try again"}
          className="shrink-0 cursor-pointer rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-amber-100 transition hover:bg-amber-400/20 disabled:cursor-default disabled:opacity-40"
        >
          {pending ? "retrying…" : retryIn > 0 ? `↻ retry in ${retryIn}s` : "↻ retry"}
        </button>
      </span>
    </ErrorBanner>
  );
}
