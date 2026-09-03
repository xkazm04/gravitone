"use client";

// What the console knows about the engine BEFORE a render is committed to: the
// health snapshot, its optional metrics, and the one sentence that states the
// consequence of pressing Generate right now.

import { useHealthPoll } from "@/lib/useHealthPoll";

export function usePlaygroundEngine(busy: boolean) {
  // Engine state BEFORE the user commits to a render. The page most affected by
  // a loading or draining engine used to discover that state only by failing a
  // generate. Same shared poller the benchmarks view uses — faster cadence
  // while a render is in flight so the queue reading stays current.
  const { health, stale: healthStale } = useHealthPoll(busy ? 5_000 : 30_000);
  const engineStatus = health?.status;                       // ready | loading | draining
  // The engine's live metrics are OPTIONAL in the health response: they are
  // gated behind the observability scope, and a studio with no
  // GRAVITONE_API_KEY talking to a keyed backend is a legitimate deployment
  // (web/lib/backend.ts attaches the key only when one is configured). Missing
  // therefore means UNAVAILABLE, never zero — `Number(undefined ?? 0)` turned
  // "we cannot see the queue" into "the queue is empty".
  const metric = (key: string): number | null => {
    const v = health?.metrics?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const queued = metric("queued");
  const inFlight = metric("in_flight");
  // The engine ANSWERED, and told us nothing about its queue. (A backend the
  // studio cannot reach at all is a different sentence, and the engine notice
  // above already says it.)
  const metricsUnavailable =
    !!health && engineStatus !== "unreachable" && queued === null && inFlight === null;
  // null = nothing worth saying. Every string states the CONSEQUENCE of
  // generating right now, which is what the user is about to decide.
  const engineNotice =
    // No snapshot AND the poll is failing: the studio cannot even reach its own
    // /api/health route, so it knows nothing — and silence there reads exactly
    // like a healthy engine.
    !health ? (healthStale
      ? "The studio cannot reach its backend — generating now plays your operating system's built-in speech, not Gravitone."
      : null)
    : engineStatus === "ready" ? null
    // Stated BEFORE the click, and stated as what will actually come out of the
    // speakers — "falls back to your browser voice" reads as a Gravitone mode
    // to anyone who has not read the source.
    : engineStatus === "loading" ? "Gravitone is still loading its model — generating now plays your operating system's built-in speech, not Gravitone."
    : engineStatus === "draining" ? "Gravitone is restarting — generating now plays your operating system's built-in speech, not Gravitone."
    : "Backend not reachable — the studio is playing your operating system's built-in speech, not Gravitone (metatags ignored). Start the service to hear the real engine.";

  return { healthStale, metric, queued, inFlight, metricsUnavailable, engineNotice };
}
