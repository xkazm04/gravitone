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

import { Fragment, useEffect, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import AgentBlocks from "./AgentBlocks";
import KeysEmpty from "./KeysEmpty";
import SecretReveal from "./SecretReveal";
import { provenScopes, readAttestation, restate, type Attestation } from "./attestation";
import type { Posture } from "./probes";
import { SCOPES, relTime, useKeys, type ApiKeyWithSecret } from "./data";

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

/** The posture strip — no longer a guess.
 *
 *  This page used to say "can't tell from here", and it was telling the truth:
 *  every request went through the studio's proxy, which attaches its own root
 *  key, so an enforcing backend and a wide-open one answered identically. The
 *  probe route (`/api/keys/probe`) makes the one measurement that separates
 *  them — an UNAUTHENTICATED request, sent server-side with no credential at
 *  all — and this strip reports what came back:
 *
 *    open        the deployment served a request carrying no key. The keys
 *                below enforce NOTHING. This is the loudest thing on the page.
 *    enforced    the deployment refused it. Only TTS_API_KEY does that.
 *    unreachable nothing answered — no posture is claimed for a silent box.
 *    unmeasured  the probe has not answered yet. Not reassurance; absence. */
function PostureNote({ state, checkedAt }: { state: Posture; checkedAt: string | null }) {
  if (state === "unreachable") return null; // the error banner already says it
  if (state === "unmeasured") {
    return (
      <p className="font-jetbrains mt-4 text-[11px] text-white/45">
        Measuring key enforcement — sending one unauthenticated request to your deployment…
      </p>
    );
  }
  const when = checkedAt ? ` Probed ${relTime(checkedAt)}.` : "";
  if (state === "open") {
    return (
      <div role="alert" className="mt-4 rounded-xl border border-rose-400/40 bg-rose-400/10 px-4 py-3">
        <p className="font-jetbrains text-[11px] uppercase tracking-widest text-rose-300">
          this deployment is open to everyone
        </p>
        <p className="font-hanken mt-2 text-sm text-rose-100/90">
          A request carrying <strong className="font-semibold">no key at all</strong> was served. Every key below
          enforces nothing — anyone who can reach this host can synthesize, clone and manage voices on it. Set{" "}
          <Code>TTS_API_KEY</Code> on the box and restart; until then the ledger is a list of names, not access
          control.{when}
        </p>
        <p className="font-jetbrains mt-2 text-[10px] leading-relaxed text-rose-100/70">
          <RootKeyConsequences />
        </p>
      </div>
    );
  }
  return (
    <p className="font-jetbrains mt-4 rounded-lg border border-cyan-400/25 bg-cyan-400/5 px-4 py-2 text-[11px] text-cyan-200/90">
      Key enforcement is <strong className="font-semibold">ON</strong> — an unauthenticated request to this
      backend was refused, which only a configured <Code>TTS_API_KEY</Code> does, so the keys below really do
      gate access.{when} If this page cannot load keys, <Code>GRAVITONE_API_KEY</Code> in the studio&apos;s
      environment does not hold a key the backend accepts. <RootKeyConsequences />
    </p>
  );
}

/** Scope chips, in the honesty grammar the page already uses for revoked rows:
 *  SOLID = proved by a probe that watched this deployment serve it, with the
 *  timestamp of that probe; OUTLINED (dashed) = declared only — a string
 *  somebody typed, never observed. A proof is this browser's memory of a sweep
 *  run at mint/rotate (see attestation.ts), and it stops counting when the
 *  posture changes underneath it. */
function ScopeChips({ scopes, proof }: { scopes: string[]; proof: Attestation | null }) {
  const proven = new Set(provenScopes(proof));
  const stamp = proof?.checkedAt ? relTime(proof.checkedAt) : "";
  return (
    <div className="flex flex-wrap gap-1">
      {scopes.map((s) =>
        proven.has(s) ? (
          <span key={s}
            title={`Proven: this deployment served a ${s}-scoped request from this key when probed ${stamp}.`}
            className="font-jetbrains rounded border border-emerald-400/40 bg-emerald-400/15 px-1.5 py-0.5 text-[10px] text-emerald-200">
            {s} ✓ {stamp}
          </span>
        ) : (
          <span key={s}
            title="Declared only — nothing has ever observed this deployment accepting this key for this scope."
            className="font-jetbrains rounded border border-dashed border-white/20 px-1.5 py-0.5 text-[10px] text-white/55">
            {s}
          </span>
        ),
      )}
    </div>
  );
}

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
              <Fragment key={k.id}>
              {/* Revoked keys STAY listed — keeping them auditable is what
                  revoke is for. Dimmed + struck through + labelled, matching
                  profile/MyVoices' revoked clone rows. */}
              <tr className={`border-b border-white/5 transition hover:bg-white/[0.03] ${k.revoked ? "opacity-50" : ""}`}>
                <td className="px-3 py-2.5 text-sm font-medium text-white">
                  {k.revoked ? <s>{k.name}</s> : k.name}
                  {k.revoked && <span className="font-jetbrains ml-2 text-[10px] uppercase tracking-widest text-rose-300/80">revoked</span>}
                </td>
                <td className="font-jetbrains px-3 py-2.5 text-[12px] text-cyan-200/90">{k.prefix}</td>
                <td className="px-3 py-2.5">
                  <ScopeChips scopes={k.scopes} proof={proofs[k.id] ?? null} />
                  {/* A scope this key was NOT granted, served anyway, is a live
                      privilege escalation — it belongs on the row, not in a log. */}
                  {(proofs[k.id]?.served.length ?? 0) > 0 && (
                    <p className="font-jetbrains mt-1 text-[10px] text-rose-300">
                      ⚠ served {proofs[k.id]?.served.join(", ")} — never granted
                    </p>
                  )}
                  {proofs[k.id]?.stale && (
                    <p className="font-jetbrains mt-1 text-[10px] text-amber-200/90">
                      proof retired — the deployment&apos;s posture changed since it was taken
                    </p>
                  )}
                </td>
                <td className="font-jetbrains px-3 py-2.5 text-[12px] text-white/60">{relTime(k.created)}</td>
                <td className="font-jetbrains px-3 py-2.5 text-[12px] text-white/60">{relTime(k.last_used)}</td>
                <td className="px-3 py-2.5 text-right">
                  <button
                    // Disabled while ANY row is rotating, not just this one:
                    // the handler's `if (rotating) return` made every other
                    // row's rotate button a silent no-op — a click that looks
                    // live and does nothing is the failure this repo bans.
                    disabled={rotating !== null}
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
                  {/* Secretless by necessity: the secret was shown once and is
                      gone, so this re-measures the posture the proof depends on
                      — not the scope matrix, which would need the key itself. */}
                  <button
                    onClick={() => void reprove(k.id)}
                    disabled={reproving !== null}
                    title="Re-run the unauthenticated posture probe. It cannot re-run the scope sweep — that needs the secret, which was shown once. Rotate to prove the scopes again."
                    className="font-jetbrains ml-3 text-[11px] text-cyan-300/60 transition hover:text-cyan-200 disabled:cursor-not-allowed disabled:text-white/25">
                    {reproving === k.id ? "re-proving…" : "re-prove"}
                  </button>
                  {/* The key as a machine reads it. Needs no secret: the
                      manifest is derived from the key's scopes, and the config
                      it fills references an env var — which is what the block
                      should say anyway, since a config file is a place a secret
                      goes to get committed. */}
                  <button
                    onClick={() => setAgentFor((cur) => (cur === k.id ? null : k.id))}
                    aria-expanded={agentFor === k.id}
                    title="Regenerate this key's agent install block (MCP server config or tool schema) from its capability manifest. No secret needed."
                    className="font-jetbrains ml-3 text-[11px] text-cyan-300/60 transition hover:text-cyan-200">
                    {agentFor === k.id ? "hide agent config" : "agent config"}
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
              {agentFor === k.id && (
                <tr className="border-b border-white/5 bg-black/20">
                  <td colSpan={6} className="px-3 py-4">
                    {/* `secret` is deliberately absent: this key's secret was
                        shown once and is gone, so the block offers the env-var
                        reference and points at rotate rather than pretending a
                        raw value could be filled in. */}
                    <AgentBlocks keyId={k.id} />
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
