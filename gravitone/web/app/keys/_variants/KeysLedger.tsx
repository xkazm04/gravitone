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

import { useEffect, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import KeysEmpty from "./KeysEmpty";
import KeysLedgerRow from "./KeysLedgerRow";
import PostureNote from "./KeysPostureNote";
import SecretReveal from "./SecretReveal";
import { readAttestation, restate, type Attestation } from "./attestation";
import { SCOPES, useKeys, type ApiKeyWithSecret } from "./data";

export default function KeysLedger() {
  const {
    keys, loading, error, posture, postureCheckedAt, provePosture,
    createKey, rotateKey, revokeKey, destroyKey,
  } = useKeys();
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
  // Proofs live in this browser (attestation.ts), so they are read in an effect
  // — never during render, which would differ between server and client HTML.
  const [proofs, setProofs] = useState<Record<string, Attestation | null>>({});
  const [reproving, setReproving] = useState<string | null>(null);
  // Which row has its agent-config panel open. One at a time: the panel is a
  // full-width row under its key, and two open at once would separate a config
  // from the key it belongs to.
  const [agentFor, setAgentFor] = useState<string | null>(null);

  useEffect(() => {
    const next: Record<string, Attestation | null> = {};
    for (const k of keys) next[k.id] = readAttestation(k.id);
    setProofs(next);
  }, [keys]);

  /** Re-prove, for a key whose secret is long gone. It can only re-measure the
   *  half that needs no credential — the deployment's posture — and that is
   *  exactly what goes stale: a matrix proved against an enforcing box says
   *  nothing once the box is open. A changed posture retires the proof rather
   *  than leaving solid chips sitting on top of it. */
  async function reprove(id: string) {
    if (reproving) return;
    setReproving(id); setErr(null);
    try {
      const sweep = await provePosture();
      if (!sweep) { setErr("re-prove failed — the probe could not be run"); return; }
      setProofs((p) => ({ ...p, [id]: restate(id, sweep.posture, sweep.checkedAt) }));
    } finally { setReproving(null); }
  }

  async function rotate(id: string) {
    // In-flight guard: a double-click used to fire two
    // rotations, minting two secrets where the second
    // invalidates the first and the reveal shows whichever
    // resolved last. rotateKey also throws (e.g. "cannot
    // rotate a revoked key") — unhandled that was an
    // invisible rejection.
    if (rotating) return;
    setRotating(id); setErr(null);
    try { setReveal(await rotateKey(id)); }
    catch (e) { setErr(e instanceof Error ? e.message : "rotate failed"); }
    finally { setRotating(null); }
  }

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
      {/* Closing the reveal is when a sweep's verdicts become the ledger's:
          the proof was written while this dialog was open, under the key's id. */}
      <SecretReveal
        keyData={reveal}
        onClose={() => {
          const id = reveal?.id;
          setReveal(null);
          if (id) setProofs((p) => ({ ...p, [id]: readAttestation(id) }));
        }}
      />
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

      {/* Whether these keys enforce anything is measured, not inferred. */}
      <PostureNote state={posture} checkedAt={postureCheckedAt} />

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
            {/* "No keys yet" is a CLAIM about the account, and a load that
                failed cannot make it — an empty table under a red banner used
                to say the user has no keys when the truth is nobody knows. */}
            {/* A ledger that loaded and is empty is a fact about the account,
                so it teaches: the drawing says what a key DOES here — and it
                draws the unkeyed lane from the probe's own verdict, never from
                the idea, because on an `open` deployment "without one → refused"
                would be the exact lie the posture strip above just disproved. */}
            {!loading && keys.length === 0 && !error && (
              <tr><td colSpan={6} className="px-3 py-10 text-center text-sm text-white/60">
                <KeysEmpty posture={posture}>No keys yet — create one above.</KeysEmpty>
              </td></tr>
            )}
            {!loading && keys.length === 0 && error && <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-rose-200/80">Key list unavailable — this table is empty because the request failed, not because you have no keys.</td></tr>}
            {keys.map((k) => (
              <KeysLedgerRow
                key={k.id}
                k={k}
                proof={proofs[k.id] ?? null}
                rotating={rotating}
                reproving={reproving}
                killing={killing}
                agentOpen={agentFor === k.id}
                onRotate={() => void rotate(k.id)}
                onReprove={() => void reprove(k.id)}
                onToggleAgent={() => setAgentFor((cur) => (cur === k.id ? null : k.id))}
                onRevoke={() => void kill(k.id, "revoke")}
                onDestroy={() => confirmDestroy(k.id, k.name)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
