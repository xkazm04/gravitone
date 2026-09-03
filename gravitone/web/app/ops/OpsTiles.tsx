"use client";

// The tile grammar /ops is drawn in: one measurement per box, grouped under a
// hairline label. Purely presentational — nothing here reads the engine.

/** One number, or an em dash.
 *
 *  The em dash is load-bearing. Several of these fields are null on a real,
 *  healthy engine — `realtime_factor` until it has both a compute window and an
 *  audio window, the latency percentiles until something has been served — and
 *  a `?? 0` here would render an engine that has not measured itself yet as an
 *  engine measuring zero. `hint` says which of the two it is. */
export function Stat({
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
export function SectionLabel({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="font-jetbrains shrink-0 text-[11px] uppercase tracking-widest text-white/50">
        {title}
      </h2>
      <span aria-hidden className="h-px flex-1 bg-white/8" />
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <SectionLabel title={title} />
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">{children}</div>
    </section>
  );
}

export function Deployment({ config }: { config: Record<string, unknown> | undefined }) {
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
