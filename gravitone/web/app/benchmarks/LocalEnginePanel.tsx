"use client";

// "Could this browser run a local engine?" — the diagnostics card on the public
// proof page.
//
// It is on /benchmarks and nowhere else on purpose: this page is where the
// product already says "here are the numbers, run them yourself", and a
// capability probe is the same kind of claim. It renders what the browser
// actually reported, including the parts the browser refused to report, and it
// says plainly that the local engine does not exist yet. A card that let a
// visitor believe the page was about to synthesize locally would be the exact
// lie the seam was built to avoid.
//
// Nothing here plays audio, downloads anything, or runs a model.

import { useEffect, useState } from "react";
import { useMounted } from "@/lib/useMounted";
import {
  LOCAL_ENGINE_WEIGHTS_MB,
  probeLocalEngine,
  type EngineProbeReport,
  type ProbeSignal,
} from "@/lib/engineProbe";
import { getEngine } from "@/lib/engineSeam";

/** Word-first status, so the verdict never depends on a colour. */
function statusWord(ok: boolean | null): string {
  return ok === null ? "unknown" : ok ? "yes" : "no";
}

function signalTone(s: ProbeSignal): string {
  if (s.ok === null) return "text-white/55";
  if (s.ok) return "text-emerald-200/90";
  return s.weight === "optional" ? "text-white/55" : "text-amber-200/90";
}

function SignalRow({ s }: { s: ProbeSignal }) {
  return (
    <li className="flex flex-col gap-0.5 border-t border-white/5 py-2 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-white/85">
          {s.label}
          {s.weight !== "required" && (
            <span className="font-jetbrains ml-2 text-[10px] uppercase tracking-[0.14em] text-white/35">
              {s.weight}
            </span>
          )}
        </span>
        <span className={`font-jetbrains shrink-0 text-[12px] ${signalTone(s)}`}>
          {statusWord(s.ok)}
        </span>
      </div>
      <p className="font-jetbrains text-[11px] leading-relaxed text-white/45">{s.detail}</p>
    </li>
  );
}

export default function LocalEnginePanel() {
  const [report, setReport] = useState<EngineProbeReport | null>(null);
  const [failed, setFailed] = useState(false);
  const mounted = useMounted();

  useEffect(() => {
    void probeLocalEngine()
      .then((r) => { if (mounted.current) setReport(r); })
      .catch(() => { if (mounted.current) setFailed(true); });
  }, [mounted]);

  // The engine actually in use right now — the honest counterweight to the
  // verdict above it.
  const caps = getEngine().capabilities();

  const missingLabels = report
    ? report.missing.map((id) => report.signals.find((s) => s.id === id)?.label ?? id)
    : [];

  return (
    <section aria-labelledby="local-engine-probe" className="glass-panel mt-6 rounded-3xl p-6">
      <h3 id="local-engine-probe" className="font-instrument text-xl text-white">
        Could this browser run a local engine?
      </h3>

      {!report && !failed && (
        <p role="status" className="font-jetbrains mt-3 text-[12px] text-white/55">
          checking this browser…
        </p>
      )}

      {failed && (
        <p role="status" className="font-jetbrains mt-3 text-[12px] text-amber-200/90">
          the capability probe did not complete — this browser&apos;s support is unknown, not absent
        </p>
      )}

      {report && (
        <>
          <p className="mt-3 text-sm leading-relaxed text-slate-300/90">
            <span className={`font-jetbrains mr-2 rounded-full border px-2.5 py-0.5 text-[11px] uppercase tracking-[0.14em] ${
              report.capable
                ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
                : "border-amber-400/25 bg-amber-400/10 text-amber-200"
            }`}>
              {report.capable ? "capable" : "not capable"}
            </span>
            {report.capable
              ? "every requirement a local engine has is present here."
              : "this browser is missing something a local engine cannot do without."}
            {missingLabels.length > 0 && (
              <> Missing: <span className="text-amber-200/90">{missingLabels.join(", ")}</span>.</>
            )}
            {report.unknown.length > 0 && (
              <> Not answered by this browser: <span className="text-white/70">{report.unknown.join(", ")}</span>.</>
            )}
          </p>

          <ul className="mt-4 space-y-0">
            {report.signals.map((s) => <SignalRow key={s.id} s={s} />)}
          </ul>

          <div className="mt-5 rounded-2xl border border-white/8 bg-black/30 p-4">
            <h4 className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-cyan-300">
              what a local engine would need
            </h4>
            <ul className="font-jetbrains mt-2 space-y-1 text-[11px] leading-relaxed text-white/55">
              <li>~{LOCAL_ENGINE_WEIGHTS_MB} MB of weights (estimated from the model size — the ONNX export does not exist yet), downloaded once and cached</li>
              <li>COOP/COEP response headers for threaded WASM, which also change how third-party embeds behave on this page</li>
              <li>WASM SIMD for anything close to realtime; WebGPU is a bonus, never the plan</li>
            </ul>
          </div>

          {report.notes.map((n) => (
            <p key={n} className="font-jetbrains mt-3 text-[11px] leading-relaxed text-white/45">{n}</p>
          ))}

          <p className="font-jetbrains mt-3 text-[11px] leading-relaxed text-white/45">
            Right now every audible byte on this site comes from the{" "}
            <span className="text-white/70">{caps.label}</span>
            {caps.onDevice ? "" : " — audio is synthesized on a server, not in this tab"}.
          </p>
        </>
      )}
    </section>
  );
}
