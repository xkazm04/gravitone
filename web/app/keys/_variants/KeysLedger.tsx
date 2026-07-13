"use client";

// LEDGER — dense operations table. Inline create bar, one row per key with
// prefix / scopes / created / last-used / rotate / revoke. Practical, scales.

import { useState } from "react";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import SecretReveal from "./SecretReveal";
import { SCOPES, relTime, useKeys, type ApiKeyWithSecret } from "./data";

export default function KeysLedger() {
  const { keys, loading, error, createKey, rotateKey, deleteKey } = useKeys();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["tts"]);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<ApiKeyWithSecret | null>(null);
  const [err, setErr] = useState<string | null>(null);

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

  return (
    <div className="pb-24">
      <SecretReveal keyData={reveal} onClose={() => setReveal(null)} />
      <Eyebrow>security</Eyebrow>
      <h1 className="font-instrument mt-4 text-4xl text-white">API keys.</h1>
      <p className="mt-2 max-w-2xl text-base text-white/70">
        Issue keys for other apps to call your Gravitone API. Send them as{" "}
        <span className="font-jetbrains text-cyan-300">xi-api-key</span> — the same header ElevenLabs
        clients already send, so a new key plus a base-URL swap is a complete migration. Secrets are shown once.
      </p>

      {(error || err) && (
        <p className="font-jetbrains mt-4 rounded-lg border border-amber-400/25 bg-amber-400/5 px-4 py-2 text-[11px] text-amber-200/90">{error ?? err}</p>
      )}

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
              <tr key={k.id} className="border-b border-white/5 transition hover:bg-white/[0.03]">
                <td className="px-3 py-2.5 text-sm font-medium text-white">{k.name}</td>
                <td className="font-jetbrains px-3 py-2.5 text-[12px] text-cyan-200/90">{k.prefix}</td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {k.scopes.map((s) => <span key={s} className="font-jetbrains rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/70">{s}</span>)}
                  </div>
                </td>
                <td className="font-jetbrains px-3 py-2.5 text-[12px] text-white/60">{relTime(k.created)}</td>
                <td className="font-jetbrains px-3 py-2.5 text-[12px] text-white/60">{relTime(k.last_used)}</td>
                <td className="px-3 py-2.5 text-right">
                  <button onClick={async () => setReveal(await rotateKey(k.id))} className="font-jetbrains text-[11px] text-cyan-300/80 transition hover:text-cyan-200">rotate</button>
                  <button onClick={() => deleteKey(k.id)} className="font-jetbrains ml-3 text-[11px] text-white/45 transition hover:text-rose-300">revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
