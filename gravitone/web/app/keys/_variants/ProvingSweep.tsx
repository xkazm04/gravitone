"use client";

// The proving sweep, rendered in the ONE moment the studio holds a raw secret:
// the create/rotate reveal. Until now that moment was spent on a single
// happy-path compatibility tick (MigrationKit, still below this panel); it is
// the only chance to ask the deployment what this key can ACTUALLY reach,
// because after the dialog closes the secret is gone forever.
//
// Never automatic. A sweep sends a real one-word synthesis among its six
// requests, so it happens when a human presses the button, one request at a
// time, and never again for that key.
//
// The four verdicts are not four flavours of the same thing:
//   proven               — granted, and served. The chip earns its solid fill.
//   correctly-refused    — not granted, and refused. Scoping did its job.
//   granted-but-refused  — the ledger says yes, the deployment says no.
//   REFUSED-SCOPE-SERVED — a scope this key was NOT granted was served anyway.
//                          That is a live privilege escalation on this box, so
//                          it is an alert, not a shrug.

import { useCallback, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { authedFetch } from "@/lib/authedFetch";
import { writeAttestation } from "./attestation";
import { PROBE_PLAN, servedScopesThatShouldNotBe, type ProbeResult, type Sweep } from "./probes";

type State =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; sweep: Sweep; saved: boolean }
  | { phase: "failed"; reason: string };

const WHY = new Map(PROBE_PLAN.map((p) => [p.scope, p.why]));

/** Verdict → (glyph, label, colour). Rose is failure, amber is a caveat, and
 *  emerald is the only colour a proof may use — the repo's existing grammar. */
const VERDICT: Record<ProbeResult["verdict"], { mark: string; label: string; tone: string }> = {
  "proven": { mark: "✓", label: "granted and served", tone: "text-emerald-300" },
  "correctly-refused": { mark: "✓", label: "not granted, refused", tone: "text-cyan-200/90" },
  "granted-but-refused": { mark: "✗", label: "granted, but refused", tone: "text-rose-300" },
  "REFUSED-SCOPE-SERVED": { mark: "⚠", label: "NOT granted — SERVED ANYWAY", tone: "text-rose-300" },
  "unreachable": { mark: "–", label: "nothing answered", tone: "text-white/45" },
};

export default function ProvingSweep({
  keyId,
  secret,
  scopes,
}: {
  keyId: string;
  secret: string;
  scopes: string[];
}) {
  const [state, setState] = useState<State>({ phase: "idle" });

  const run = useCallback(async () => {
    setState({ phase: "running" });
    try {
      const r = await authedFetch("/api/keys/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, granted: scopes }),
      });
      if (!r.ok) {
        setState({ phase: "failed", reason: `the studio could not run the sweep (${r.status})` });
        return;
      }
      const sweep = (await r.json()) as Sweep;
      // Saving can fail (storage blocked/full). Say so rather than letting the
      // ledger show declared-only chips with no explanation.
      const saved = writeAttestation(keyId, sweep) !== null;
      setState({ phase: "done", sweep, saved });
    } catch {
      setState({ phase: "failed", reason: "the sweep request failed" });
    }
  }, [keyId, scopes, secret]);

  return (
    <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
          prove this key — least privilege, observed
        </span>
        <button
          onClick={() => void run()}
          disabled={state.phase === "running"}
          className="font-jetbrains cursor-pointer rounded-lg border border-cyan-400/30 bg-cyan-400/5 px-3 py-1.5 text-[11px] text-cyan-200 transition hover:bg-cyan-400/10 disabled:opacity-50"
        >
          {state.phase === "running"
            ? "probing…"
            : state.phase === "done"
              ? "prove again"
              : "prove this key"}
        </button>
      </div>

      {state.phase === "idle" && (
        <p className="font-jetbrains mt-3 text-[10px] leading-relaxed text-white/50">
          Sends one request per scope with this secret — the scopes you granted and the ones you did
          not — and reports what the deployment did with each. Runs once, on this click; the{" "}
          <span className="text-white/70">tts</span> probe is a real one-word synthesis, everything
          else is a read or a deliberately empty body that fails after the key is checked. This is
          the last moment the secret exists, so a proof taken later is not possible.
        </p>
      )}

      {state.phase === "failed" && <ErrorBanner className="mt-3">✗ {state.reason}</ErrorBanner>}

      {state.phase === "done" && <SweepReport sweep={state.sweep} saved={state.saved} />}
    </div>
  );
}

function SweepReport({ sweep, saved }: { sweep: Sweep; saved: boolean }) {
  const served = servedScopesThatShouldNotBe(sweep.probes);

  if (sweep.posture === "unreachable") {
    return (
      <ErrorBanner className="mt-3">
        Nothing answered at the backend, so nothing was proved. The key exists; whether it is
        enforced anywhere is unknown.
      </ErrorBanner>
    );
  }

  return (
    <div className="mt-3">
      {sweep.posture === "open" && (
        <ErrorBanner className="mb-3">
          This deployment served an <strong className="font-semibold">unauthenticated</strong> request.
          Every verdict below is the deployment being open, not this key being scoped — the key
          enforces nothing until <span className="text-white/80">TTS_API_KEY</span> is set on the box.
        </ErrorBanner>
      )}
      {served.length > 0 && sweep.posture !== "open" && (
        <ErrorBanner className="mb-3">
          ⚠ {served.map((p) => p.scope).join(", ")} — this key was NOT granted{" "}
          {served.length === 1 ? "that scope" : "those scopes"} and the deployment served{" "}
          {served.length === 1 ? "it" : "them"} anyway. Anyone holding this key can do that today.
        </ErrorBanner>
      )}

      <table className="w-full border-collapse text-left">
        <tbody>
          {sweep.probes.map((p) => {
            const v = VERDICT[p.verdict];
            return (
              <tr key={p.scope} className="border-b border-white/5 last:border-0">
                <td className="font-jetbrains py-1.5 pr-2 text-[11px] text-white/80">{p.scope}</td>
                <td className={`font-jetbrains py-1.5 pr-2 text-[11px] ${v.tone}`}>
                  {v.mark} {v.label}
                </td>
                <td className="font-jetbrains py-1.5 text-[10px] text-white/40">
                  {p.request} → {p.status ?? "no answer"}
                  {WHY.get(p.scope) ? ` · ${WHY.get(p.scope)}` : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* The limit of the instrument, stated with the result. service/auth.py
          answers 401 for "no key" and "valid key, wrong scope" alike, so a
          refusal alone cannot tell those apart — only a served POSITIVE probe
          in the same sweep proves the key is recognised at all. */}
      {!sweep.negativesConclusive && (
        <ErrorBanner severity="warning" className="mt-3">
          Nothing this key was granted came back served, so the refusals above prove only that the
          deployment does not recognise this key — not that scope boundaries hold.
        </ErrorBanner>
      )}

      <p className="font-jetbrains mt-2 text-[10px] leading-relaxed text-white/50">
        Probed {new Date(sweep.checkedAt).toLocaleString()}.{" "}
        {saved
          ? "Saved in this browser, so the ledger can show these scopes as proven — with this timestamp, because a proof expires the moment TTS_API_KEY changes on the box."
          : "This browser refused to store the result, so the ledger will keep showing these scopes as declared-only."}
      </p>
    </div>
  );
}
