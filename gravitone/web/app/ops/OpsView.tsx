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

// How many consecutive failed reads before the poller stops being "a blip" and
// starts being "the backend is gone". One failure during a redeploy is noise;
// three at a 5s cadence is fifteen seconds of blindness, which an operator
// needs told rather than inferred from numbers that stopped moving.
const DEGRADED_AFTER = 3;

function fmtSeconds(v: number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
}

function fmtCount(v: number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v.toLocaleString("en-US");
}

/** One number, or an em dash.
 *
 *  The em dash is load-bearing. Several of these fields are null on a real,
 *  healthy engine — `realtime_factor` until it has both a compute window and an
 *  audio window, the latency percentiles until something has been served — and
 *  a `?? 0` here would render an engine that has not measured itself yet as an
 *  engine measuring zero. `hint` says which of the two it is. */
function Stat({
  label, value, hint, accent = false,
}: { label: string; value: string | null; hint?: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-white/8 bg-black/30 p-4">
      <div className="font-jetbrains text-[10px] uppercase tracking-widest text-white/45">
        {label}
      </div>
      <div
        className={`font-jetbrains mt-1.5 text-[22px] leading-none ${
          value === null ? "text-white/25" : accent ? "text-cyan-200" : "text-white/90"
        }`}
      >
        {value ?? "—"}
      </div>
      {hint && (
        <div className="font-jetbrains mt-1.5 text-[10px] leading-relaxed text-white/40">
          {hint}
        </div>
      )}
    </div>
  );
}

/** A mono label with a hairline running out of it to the page edge.
 *
 *  The house chrome idiom (web/DESIGN.md, restrained tier), and the whole of
 *  what Signal is allowed to do on this page: /ops is numbers-first, every tile
 *  is a measurement, and the language's job here is to separate the groups —
 *  not to draw anything. No motion, no accent, no picture. */
function SectionLabel({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="font-jetbrains shrink-0 text-[11px] uppercase tracking-widest text-white/50">
        {title}
      </h2>
      <span aria-hidden className="h-px flex-1 bg-white/8" />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <SectionLabel title={title} />
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">{children}</div>
    </section>
  );
}

function Deployment({ config }: { config: Record<string, unknown> | undefined }) {
  if (!config) return null;
  // Only the scalars an operator reads at a glance. `tuning` and `scheduling`
  // are nested policy dumps — real, but a table, not a dashboard tile.
  const rows: [string, unknown][] = [
    ["workers", config.workers],
    ["queue max", config.queue_max],
    ["max in flight", config.max_in_flight],
    ["torch threads", config.torch_threads],
    ["language", config.language],
    ["quantize", config.quantize],
  ];
  const shown = rows.filter(([, v]) => v !== undefined && v !== null);
  if (!shown.length) return null;
  return (
    <section className="mt-8">
      <SectionLabel title="This replica" />
      <div className="font-jetbrains mt-3 flex flex-wrap gap-x-6 gap-y-2 rounded-xl border border-white/8 bg-black/30 p-4 text-[11px] text-white/60">
        {shown.map(([k, v]) => (
          <span key={k}>
            {k} <span className="text-white/85">{String(v)}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

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
