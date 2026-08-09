"use client";

// Live engine telemetry — the transparency half of the ElevenLabs argument.
// Reviewers of the hosted product cite "limited production monitoring"; this
// deployment's answer is that the numbers the scheduler makes decisions on are
// the same numbers you can read, at the cadence they change.
//
// EVERY FIELD RENDERED HERE IS A FIELD /metrics ACTUALLY RETURNS
// (service/engine.py Metrics.counters/snapshot + cost_model, SynthCache.stats,
// TtsEngine.config). Nothing is derived into a prettier metric that the backend
// does not stand behind, and nothing is defaulted to 0 — see `Stat` below for
// why null is rendered as "—" rather than as a number.

import { useMetricsPoll, type MetricsPayload } from "@/lib/useMetricsPoll";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Deployment, Section, Stat } from "./OpsTiles";
import { fmtCount, fmtSeconds } from "./opsFormat";

// How many consecutive failed reads before the poller stops being "a blip" and
// starts being "the backend is gone". One failure during a redeploy is noise;
// three at a 5s cadence is fifteen seconds of blindness, which an operator
// needs told rather than inferred from numbers that stopped moving.
const DEGRADED_AFTER = 3;

export default function OpsView() {
  const { data, error, failures, stale, loading } = useMetricsPoll(5_000);
  const m = data?.metrics ?? {};
  const cache = data?.cache;
  const degraded = failures >= DEGRADED_AFTER;

  return (
    <div className="py-10">
      <header>
        <h1 className="font-hanken text-[26px] text-white/90">Engine ops</h1>
        <p className="font-jetbrains mt-2 max-w-2xl text-[12px] leading-relaxed text-white/50">
          Live from this replica&apos;s <span className="text-white/70">/metrics</span>, every 5 seconds.
          These are the counters the scheduler itself reads — not a summary of them.
          Counters are per PROCESS: with several replicas behind one address
          (service/replicas.py) each answers for its own work.
        </p>
      </header>

      {/* A poller that retries forever has to say the connection is degraded
          (repo law). Escalating, so one blip during a redeploy is not shouted
          about but real blindness is. Rose for the failure, amber for the
          caveat — the ErrorBanner severity contract. */}
      {error && (
        <ErrorBanner severity={degraded ? "error" : "warning"} className="mt-5">
          {degraded ? (
            <>
              Lost contact with the engine — {failures} failed reads in a row. {error}.
              {data
                ? " The numbers below are the last snapshot that arrived and are no longer live."
                : " Nothing has been read yet, so there is nothing to show."}
            </>
          ) : (
            <>Last read failed ({error}); retrying. The numbers below are from the previous poll.</>
          )}
        </ErrorBanner>
      )}

      {loading && !data && (
        <p className="font-jetbrains mt-6 text-[12px] uppercase tracking-widest text-white/40">
          reading /metrics…
        </p>
      )}

      {/* No data and no longer loading: say so. An empty grid of em dashes
          would read as "an engine serving nothing", which is a different
          claim from "we never got an answer". */}
      {!loading && !data && !error && (
        <ErrorBanner severity="error" className="mt-5">
          The engine returned no metrics payload.
        </ErrorBanner>
      )}

      {data && (
        <>
          {stale && !error && (
            <p className="font-jetbrains mt-4 text-[10px] uppercase tracking-widest text-amber-200/70">
              snapshot is stale
            </p>
          )}

          <Section title="Right now">
            <Stat label="In flight" value={fmtCount(m.in_flight)}
                  hint="requests inside a model this instant" accent />
            <Stat label="Queue depth" value={fmtCount(m.queued)}
                  hint="admitted, waiting for a worker" />
            <Stat label="Realtime factor" value={
                    m.realtime_factor === null || m.realtime_factor === undefined
                      ? null : `${m.realtime_factor.toFixed(2)}×`}
                  hint={m.realtime_factor === null || m.realtime_factor === undefined
                    ? "not measured yet — needs a served request"
                    : "audio seconds produced per compute second"} accent />
            <Stat label="Measurement window" value={fmtCount(m.window_size)}
                  hint="requests the percentiles are computed over" />
          </Section>

          <Section title="Latency">
            <Stat label="p50" value={fmtSeconds(m.latency_p50_s)} hint="end to end" />
            <Stat label="p95" value={fmtSeconds(m.latency_p95_s)} hint="end to end" />
            <Stat label="p99" value={fmtSeconds(m.latency_p99_s)} hint="end to end" />
            <Stat label="Synth p50" value={fmtSeconds(m.synth_p50_s)}
                  hint="model time only, no queue" />
          </Section>

          <Section title="Since this process started">
            <Stat label="Received" value={fmtCount(m.received)} />
            <Stat label="Completed" value={fmtCount(m.completed)} />
            <Stat label="Audio produced" value={
                    m.audio_seconds_total === undefined ? null
                      : `${(m.audio_seconds_total / 60).toFixed(1)} min`}
                  hint="what a metered vendor would have billed" accent />
            <Stat label="Cache hits" value={fmtCount(m.cache_hits)}
                  hint="served without synthesizing" />
          </Section>

          <Section title="Refused or lost">
            <Stat label="429 rejected" value={fmtCount(m.rejected_429)}
                  hint="backpressure — the box said no, honestly" />
            <Stat label="Errored" value={fmtCount(m.errored)} />
            <Stat label="Timed out" value={fmtCount(m.timeouts)} />
            <Stat label="Abandoned" value={fmtCount(m.abandoned)}
                  hint="caller hung up; the work was skipped un-run" />
          </Section>

          {cache && (
            <Section title="Synthesis cache (this process)">
              <Stat label="Entries" value={fmtCount(cache.entries)} />
              <Stat label="Hits" value={fmtCount(cache.hits)} />
              <Stat label="Misses" value={fmtCount(cache.misses)} />
              <Stat label="Collapsed" value={fmtCount(cache.collapsed)}
                    hint="identical concurrent requests merged onto one render" />
            </Section>
          )}

          <Deployment config={data.config} />
        </>
      )}
    </div>
  );
}
