"use client";

// LEDGER — dense operations table. Inline create bar, one row per key with
// prefix / scopes / created / last-used / rotate / revoke / destroy.
//
// Two kill actions, and the difference is the point: REVOKE stops the key
// authenticating but keeps the row (dimmed, struck through — the same language
// the Voice Vault uses for a revoked clone), so the audit trail survives; it is
// the default for a leaked key. DESTROY deletes the key AND its audit record,
// so it is labelled destructive and confirmed. Every label names the request it
// sends.

import { useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import SecretReveal from "./SecretReveal";
import { SCOPES, relTime, useKeys, type ApiKeyWithSecret, type Enforcement } from "./data";

const Code = ({ children }: { children: string }) => (
  <span className="font-jetbrains text-cyan-200/90">{children}</span>
);

/** What setting a root key COSTS, stated where the operator would act on it.
 *  Both consequences are real and neither is obvious from this page. */
function RootKeyConsequences() {
  return (
    <>
      Setting it also takes <Code>/docs</Code>, <Code>/redoc</Code> and <Code>/openapi.json</Code> offline
      (<Code>TTS_DOCS=on</Code> keeps them published), and puts <Code>/metrics</Code> — plus the engine
      config and latency percentiles on <Code>/health</Code> — behind the <Code>tts</Code> scope.
    </>
  );
}

/** The posture strip. It reports only what the studio can prove; see
 *  data.ts::Enforcement for why a served key list proves nothing.
 *
 *  A ledger full of tidy scoped keys looks like access control whether or not
 *  the deployment checks any of them, so the ambiguous case is a WARNING, not
 *  a silent omission — and the unreachable case says nothing at all about the
 *  deployment rather than inventing a posture for a box that never answered. */
function EnforcementNote({ state }: { state: Enforcement }) {
  if (state === "unreachable") return null; // the error banner already says it
  if (state === "enforced") {
    return (
      <p className="font-jetbrains mt-4 rounded-lg border border-cyan-400/25 bg-cyan-400/5 px-4 py-2 text-[11px] text-cyan-200/90">
        Key enforcement is <strong className="font-semibold">ON</strong> — this backend answered 401, which only
        a configured <Code>TTS_API_KEY</Code> does, so every request is checked and the keys below really do
        gate access. It rejected this studio too: nothing on this page will work until{" "}
        <Code>GRAVITONE_API_KEY</Code> in the studio&apos;s environment holds a key the backend accepts.{" "}
        <RootKeyConsequences />
      </p>
    );
  }
  return (
    <ErrorBanner severity="warning">
      Key enforcement: <strong className="font-semibold">can&apos;t tell from here</strong>. This page reaches the
      service through the studio&apos;s server-side proxy, which sends its own root key when it has one — so a key
      list that loads looks identical whether the deployment checks credentials or not. If{" "}
      <Code>TTS_API_KEY</Code> is unset on the box, the service serves <em>every</em> unauthenticated request and
      the keys below enforce nothing. Verify it there, not here. <RootKeyConsequences />
    </ErrorBanner>
  );
}

export default function KeysLedger() {
  const { keys, loading, error, enforcement, createKey, rotateKey, revokeKey, destroyKey } = useKeys();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["tts"]);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<ApiKeyWithSecret | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);
  // In-flight gate for the kill actions, keyed `${id}:revoke` / `${id}:destroy`:
  // a double-click used to fire two requests, and a request that kills a
  // credential must not be sent twice.
  const [killing, setKilling] = useState<string | null>(null);

  const toggleScope = (s: string) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  async function create() {
    if (!name.trim() || scopes.length === 0 || busy) return;
    setBusy(true); setErr(null);
    try {
      setReveal(await createKey(name.trim(), scopes));
      setName("");
    } catch (e) { setErr(e instanceof Error ? e.message : "create failed"); }
    finally { setBusy(false); }
  }

  async function kill(id: string, kind: "revoke" | "destroy") {
    if (killing) return;
    setKilling(`${id}:${kind}`); setErr(null);
    try { await (kind === "revoke" ? revokeKey(id) : destroyKey(id)); }
    finally { setKilling(null); }
  }

  // Destroying takes the audit record with it, so it asks first — the same
  // window.confirm gate the Voice Vault uses before a revoke there.
  function confirmDestroy(id: string, name: string) {
    if (!window.confirm(
      `Destroy "${name}"? The key AND its audit record (scopes, last used) are deleted permanently. ` +
      `If this key leaked, cancel and use revoke instead — that kills it while keeping the record.`,
    )) return;
    void kill(id, "destroy");
  }

  return (
    <div className="pb-24">
      <SecretReveal keyData={reveal} onClose={() => setReveal(null)} />
      <Eyebrow>security</Eyebrow>
      <h1 className="font-instrument mt-4 text-4xl text-white">API keys.</h1>
      <p className="mt-2 max-w-2xl text-base text-white/70">
        Issue keys for other apps to call your Gravitone API. Send them as{" "}
        <span className="font-jetbrains text-cyan-300">xi-api-key</span> — the same header ElevenLabs
        clients already send, so a new key plus a base-URL swap is a complete migration. Secrets created here
        are shown once — the only exception is the key minted at first sign-in, which this browser keeps so you
        can re-copy it from your profile until you sign out.
      </p>

      {(error || err) && <ErrorBanner>{error ?? err}</ErrorBanner>}

      {/* Whether these keys enforce anything is not inferable from their
          existence, so the page says which of the two it actually knows. */}
      {!loading && <EnforcementNote state={enforcement} />}

      {/* create bar */}
      <div className="glass-panel mt-8 rounded-2xl p-4">
        <div className="flex flex-wrap items-center gap-3">
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="Key name (e.g. Mobile app)"
            className="font-hanken w-60 rounded-lg border border-white/12 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none" />
          <div className="flex flex-wrap gap-1.5">
            {SCOPES.map((s) => {
              const on = scopes.includes(s.id);
              return (
                <button key={s.id} onClick={() => toggleScope(s.id)} title={s.hint}
                  className={`font-jetbrains cursor-pointer rounded-full border px-2.5 py-1 text-[11px] transition ${on ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60 hover:text-white"}`}>
                  {on ? "✓ " : ""}{s.label}
                </button>
              );
            })}
          </div>
          <Button onClick={create} disabled={busy || !name.trim() || scopes.length === 0} className="ml-auto px-4 py-2 text-[13px]">
            {busy ? "Creating…" : "+ Create key"}
          </Button>
        </div>
      </div>

      {/* table */}
      <div className="glass-panel mt-4 overflow-x-auto rounded-xl">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead className="border-b border-white/8">
            <tr className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
              <th className="px-3 py-2 text-left font-normal">name</th>
              <th className="px-3 py-2 text-left font-normal">key</th>
              <th className="px-3 py-2 text-left font-normal">scopes</th>
              <th className="px-3 py-2 text-left font-normal">created</th>
              <th className="px-3 py-2 text-left font-normal">last used</th>
              <th className="w-40 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-white/60">Loading keys…</td></tr>}
            {!loading && keys.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-white/60">No keys yet — create one above.</td></tr>}
            {keys.map((k) => (
              // Revoked keys STAY listed — keeping them auditable is what
              // revoke is for. Dimmed + struck through + labelled, matching
              // profile/MyVoices' revoked clone rows.
              <tr key={k.id} className={`border-b border-white/5 transition hover:bg-white/[0.03] ${k.revoked ? "opacity-50" : ""}`}>
                <td className="px-3 py-2.5 text-sm font-medium text-white">
                  {k.revoked ? <s>{k.name}</s> : k.name}
                  {k.revoked && <span className="font-jetbrains ml-2 text-[10px] uppercase tracking-widest text-rose-300/80">revoked</span>}
                </td>
                <td className="font-jetbrains px-3 py-2.5 text-[12px] text-cyan-200/90">{k.prefix}</td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {k.scopes.map((s) => <span key={s} className="font-jetbrains rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/70">{s}</span>)}
                  </div>
                </td>
                <td className="font-jetbrains px-3 py-2.5 text-[12px] text-white/60">{relTime(k.created)}</td>
                <td className="font-jetbrains px-3 py-2.5 text-[12px] text-white/60">{relTime(k.last_used)}</td>
                <td className="px-3 py-2.5 text-right">
                  <button
                    disabled={rotating === k.id}
                    onClick={async () => {
                      // In-flight guard: a double-click used to fire two
                      // rotations, minting two secrets where the second
                      // invalidates the first and the reveal shows whichever
                      // resolved last. rotateKey also throws (e.g. "cannot
                      // rotate a revoked key") — unhandled that was an
                      // invisible rejection.
                      if (rotating) return;
                      setRotating(k.id); setErr(null);
                      try { setReveal(await rotateKey(k.id)); }
                      catch (e) { setErr(e instanceof Error ? e.message : "rotate failed"); }
                      finally { setRotating(null); }
                    }}
                    className="font-jetbrains text-[11px] text-cyan-300/80 transition hover:text-cyan-200 disabled:cursor-not-allowed disabled:text-white/30">
                    {rotating === k.id ? "rotating…" : "rotate"}
                  </button>
                  {/* Revoke disappears once the key is revoked (it is already
                      dead, and the backend is idempotent about it); rotate
                      stays clickable so the backend's 409 — which states the
                      reason — is the answer a user gets. */}
                  {!k.revoked && (
                    <button
                      onClick={() => void kill(k.id, "revoke")}
                      disabled={killing !== null}
                      title="Stop this key authenticating, but keep it listed and auditable — the fix for a leak."
                      className="font-jetbrains ml-3 text-[11px] text-white/45 transition hover:text-rose-300 disabled:cursor-not-allowed disabled:text-white/25">
                      {killing === `${k.id}:revoke` ? "revoking…" : "revoke"}
                    </button>
                  )}
                  <button
                    onClick={() => confirmDestroy(k.id, k.name)}
                    disabled={killing !== null}
                    title="Delete the key AND its audit record. Permanent."
                    className="font-jetbrains ml-3 text-[11px] text-rose-300/70 transition hover:text-rose-200 disabled:cursor-not-allowed disabled:text-white/25">
                    {killing === `${k.id}:destroy` ? "destroying…" : "destroy"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
