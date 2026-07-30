"use client";

// The agent install blocks, rendered from a key's own manifest.
//
// Used in two places and identical in both: inside the reveal (where the secret
// is in hand for one moment) and from a ledger row (where it is long gone). The
// difference is not a different component — it is the SecretMode, and the copy
// next to the toggle says which situation you are in.
//
// The toolbox is the key's scopes. If a tool is missing from these blocks, this
// key cannot call it: the manifest route omits it, so nothing downstream has to
// remember to hide it.

import { useCallback, useEffect, useState } from "react";

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { readDetail } from "@/lib/apiFetch";
import { useCopyFeedback } from "@/lib/useCopyFeedback";
import { useMounted } from "@/lib/useMounted";
import { readAttestation } from "./attestation";
import { foldProof, type KeyManifest } from "./capabilities";
import {
  emptyToolboxReason,
  httpAuthHint,
  mcpServerConfig,
  openAiTools,
  SECRET_ENV,
  SECRET_GONE,
  WHY_ENV_BY_DEFAULT,
  WHY_INLINE_COSTS,
  type SecretMode,
} from "./agentConfig";

type Block = "mcp" | "tools";

const PROVEN_CHIP: Record<string, { label: string; className: string }> = {
  true: { label: "proven", className: "border-emerald-400/40 bg-emerald-400/15 text-emerald-200" },
  false: { label: "refused when probed", className: "border-rose-400/40 bg-rose-400/10 text-rose-200" },
  unknown: { label: "unproven", className: "border-dashed border-white/20 text-white/55" },
};

export default function AgentBlocks({ keyId, secret }: { keyId: string; secret?: string | null }) {
  const [manifest, setManifest] = useState<KeyManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [block, setBlock] = useState<Block>("mcp");
  const [inline, setInline] = useState(false);
  const { copy, copied, failed, reset } = useCopyFeedback();
  const mounted = useMounted();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/keys/${encodeURIComponent(keyId)}/manifest`, { cache: "no-store" });
        if (!r.ok) {
          // The route's own detail ("no such key", "backend unreachable") is
          // the diagnostic; a generic failure line would throw it away.
          const detail = await readDetail(r);
          if (!cancelled && mounted.current) setError(detail ?? `manifest unavailable (${r.status})`);
          return;
        }
        const body = (await r.json()) as KeyManifest;
        if (cancelled || !mounted.current) return;
        // The proof lives in THIS browser (attestation.ts), which is why the
        // server sent "unknown" for everything. Fold it in here, where it is.
        setManifest(foldProof(body, readAttestation(keyId)));
        setError(null);
      } catch {
        if (!cancelled && mounted.current) setError("manifest request failed");
      }
    })();
    return () => { cancelled = true; };
  }, [keyId, mounted]);

  // A different block, or a secret that just moved in or out of the text, is a
  // different thing on the clipboard — "✓ copied" must not carry over.
  useEffect(() => { reset(); }, [block, inline, reset]);

  const secretMode: SecretMode = inline ? { mode: "inline", secret: secret ?? null } : { mode: "env" };
  // The bridge fetches the manifest from THIS studio, so the config has to name
  // the origin the page is being served from — not the service's base URL,
  // which is where the tools' own requests go.
  const studioUrl = typeof window === "undefined" ? "" : window.location.origin;
  const text = manifest
    ? block === "mcp"
      ? mcpServerConfig(manifest, secretMode, studioUrl)
      : openAiTools(manifest)
    : "";

  const onCopy = useCallback(() => { if (text) void copy(text); }, [copy, text]);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!manifest) {
    return (
      <p className="font-jetbrains mt-3 text-[11px] text-white/45">Deriving this key&apos;s capability manifest…</p>
    );
  }

  const empty = emptyToolboxReason(manifest);
  const secretGone = inline && !secret;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
          hand this key to an agent
        </span>
        <div className="flex gap-1.5">
          {(["mcp", "tools"] as Block[]).map((b) => (
            <button
              key={b} onClick={() => setBlock(b)}
              className={`font-jetbrains cursor-pointer rounded-full border px-2 py-0.5 text-[10px] transition ${
                b === block ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60 hover:text-white"
              }`}
            >
              {b === "mcp" ? "mcp server" : "tool schema"}
            </button>
          ))}
        </div>
      </div>

      {/* What this key opens, before the config that installs it — the toolbox
          IS the key's scopes, and an agent that never sees a tool cannot plan
          around a call this deployment would refuse. */}
      {empty ? (
        <ErrorBanner severity="warning" className="mt-3">{empty}</ErrorBanner>
      ) : (
        <div className="mt-3 flex flex-wrap gap-1">
          {manifest.tools.map((t) => {
            const chip = PROVEN_CHIP[t.proven] ?? PROVEN_CHIP.unknown;
            return (
              <span key={t.id} title={`${t.method} ${t.endpoint} — ${t.summary} (${chip.label})`}
                className={`font-jetbrains rounded border px-1.5 py-0.5 text-[10px] ${chip.className}`}>
                {t.id}
              </span>
            );
          })}
        </div>
      )}

      <pre className="font-jetbrains mt-3 max-h-56 overflow-auto rounded-xl border border-white/8 bg-black/40 p-3 text-[11px] leading-relaxed text-cyan-100/90">
        {text}
      </pre>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={onCopy}
          className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/85 transition hover:bg-white/5"
        >
          {failed ? "copy blocked — select it" : copied ? "✓ copied" : block === "mcp" ? "copy mcp config" : "copy tool schema"}
        </button>
        {/* The secret is a CHOICE, made here, with its cost stated next to it —
            not a default somebody discovers in a committed config file. */}
        {block === "mcp" && (
          <label className="font-jetbrains flex cursor-pointer items-center gap-2 text-[11px] text-white/60">
            <input type="checkbox" checked={inline} onChange={(e) => setInline(e.target.checked)} className="cursor-pointer accent-cyan-400" />
            write the raw secret into the config
          </label>
        )}
      </div>

      {block === "mcp" && (
        <p className="font-jetbrains mt-2 text-[10px] leading-relaxed text-white/50">
          {inline ? WHY_INLINE_COSTS : WHY_ENV_BY_DEFAULT}
        </p>
      )}
      {secretGone && (
        <ErrorBanner severity="warning" className="mt-3">{SECRET_GONE}</ErrorBanner>
      )}
      {block === "tools" && (
        <p className="font-jetbrains mt-2 text-[10px] leading-relaxed text-white/50">
          For runtimes that call the HTTP API themselves. Send the key as{" "}
          <span className="text-white/70">{httpAuthHint(manifest, { mode: "env" })}</span> — export{" "}
          <span className="text-white/70">{SECRET_ENV}</span> rather than pasting it into the schema, and call
          server-side: CORS is closed by default, so a browser dies at the preflight.
        </p>
      )}
      {manifest.tools.some((t) => t.proven === "unknown") && (
        <p className="font-jetbrains mt-2 text-[10px] leading-relaxed text-white/45">
          Unproven tools are declared, not observed — nothing has watched this deployment serve them for this
          key. Mint or rotate a key to run the proving sweep while the secret is in hand.
        </p>
      )}
    </div>
  );
}
