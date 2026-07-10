"use client";

// VAULT — security-forward, card-based. A deliberate "mint a credential" panel
// on the left, issued keys as cards on the right with scope pills and a curl
// snippet. Feels ceremonial and safe rather than dense.

import { useState } from "react";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import SecretReveal from "./SecretReveal";
import { SCOPES, relTime, useKeys, type ApiKeyWithSecret } from "./data";

export default function KeysVault() {
  const { keys, loading, error, createKey, rotateKey, deleteKey } = useKeys();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["tts"]);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<ApiKeyWithSecret | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const toggleScope = (s: string) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  async function mint() {
    if (!name.trim() || scopes.length === 0 || busy) return;
    setBusy(true); setErr(null);
    try { setReveal(await createKey(name.trim(), scopes)); setName(""); setScopes(["tts"]); }
    catch (e) { setErr(e instanceof Error ? e.message : "create failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="pb-24">
      <SecretReveal keyData={reveal} onClose={() => setReveal(null)} />
      <Eyebrow>security</Eyebrow>
      <h1 className="font-instrument mt-4 text-4xl text-white">The key vault.</h1>
      <p className="mt-2 max-w-2xl text-base text-white/70">
        Mint scoped credentials for other apps. Send them as{" "}
        <span className="font-jetbrains text-cyan-300">xi-api-key</span>. The secret appears once.
      </p>

      {(error || err) && (
        <p className="font-jetbrains mt-4 rounded-lg border border-amber-400/25 bg-amber-400/5 px-4 py-2 text-[11px] text-amber-200/90">{error ?? err}</p>
      )}

      <div className="mt-8 grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
        {/* mint panel */}
        <div className="glass-panel h-fit rounded-2xl p-6">
          <div className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">mint a key</div>
          <label className="mt-4 block">
            <span className="font-jetbrains text-[11px] text-white/60">name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && mint()}
              placeholder="Mobile app"
              className="font-hanken mt-1 w-full rounded-xl border border-white/12 bg-white/[0.03] px-4 py-2.5 text-base text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none" />
          </label>
          <div className="mt-4">
            <span className="font-jetbrains text-[11px] text-white/60">scopes</span>
            <div className="mt-2 space-y-2">
              {SCOPES.map((s) => {
                const on = scopes.includes(s.id);
                return (
                  <button key={s.id} onClick={() => toggleScope(s.id)}
                    className={`flex w-full cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${on ? "border-cyan-400/40 bg-cyan-400/10" : "border-white/12 hover:border-white/25"}`}>
                    <span className={`grid h-5 w-5 place-items-center rounded border text-[11px] ${on ? "border-cyan-300 bg-cyan-300 text-slate-950" : "border-white/25 text-transparent"}`}>✓</span>
                    <span>
                      <span className="block text-sm text-white">{s.label}</span>
                      <span className="font-jetbrains text-[11px] text-white/55">{s.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <Button onClick={mint} disabled={busy || !name.trim() || scopes.length === 0} className="mt-5 w-full">
            {busy ? "Minting…" : "Mint credential"}
          </Button>
        </div>

        {/* issued cards */}
        <div className="space-y-3">
          <div className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">issued · {keys.length}</div>
          {loading && <p className="text-sm text-white/60">Loading keys…</p>}
          {!loading && keys.length === 0 && (
            <div className="rounded-2xl border border-dashed border-white/12 px-6 py-12 text-center text-sm text-white/60">
              No credentials yet — mint one on the left.
            </div>
          )}
          {keys.map((k) => (
            <div key={k.id} className="glass-panel rounded-2xl p-5">
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-base font-medium text-white">{k.name}</div>
                  <code className="font-jetbrains text-[12px] text-cyan-200/90">{k.prefix}</code>
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  {k.scopes.map((s) => <span key={s} className="font-jetbrains rounded-full border border-white/12 bg-white/5 px-2 py-0.5 text-[10px] text-white/70">{s}</span>)}
                </div>
              </div>
              <div className="mt-3 rounded-lg border border-white/8 bg-black/30 px-3 py-2">
                <code className="font-jetbrains text-[11px] text-white/60">curl -H &quot;xi-api-key: {k.prefix}&quot; …/v1/text-to-speech/alba</code>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="font-jetbrains text-[11px] text-white/55">created {relTime(k.created)} · used {relTime(k.last_used)}</span>
                <div>
                  <button onClick={async () => setReveal(await rotateKey(k.id))} className="font-jetbrains text-[11px] text-cyan-300/80 transition hover:text-cyan-200">rotate</button>
                  <button onClick={() => deleteKey(k.id)} className="font-jetbrains ml-3 text-[11px] text-white/45 transition hover:text-rose-300">revoke</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
