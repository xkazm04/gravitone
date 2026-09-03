"use client";

// One key's row in the ledger, plus the full-width agent-config row that opens
// underneath it. Every label names the request it sends.

import AgentBlocks from "./AgentBlocks";
import ScopeChips from "./KeysScopeChips";
import type { Attestation } from "./attestation";
import { relTime, type ApiKey } from "./data";

export type KeysLedgerRowProps = {
  k: ApiKey;
  proof: Attestation | null;
  rotating: string | null;
  reproving: string | null;
  killing: string | null;
  agentOpen: boolean;
  onRotate: () => void;
  onReprove: () => void;
  onToggleAgent: () => void;
  onRevoke: () => void;
  onDestroy: () => void;
};

export default function KeysLedgerRow({
  k, proof, rotating, reproving, killing, agentOpen,
  onRotate, onReprove, onToggleAgent, onRevoke, onDestroy,
}: KeysLedgerRowProps) {
  return (
    <>
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
          <ScopeChips scopes={k.scopes} proof={proof} />
          {/* A scope this key was NOT granted, served anyway, is a live
              privilege escalation — it belongs on the row, not in a log. */}
          {(proof?.served.length ?? 0) > 0 && (
            <p className="font-jetbrains mt-1 text-[10px] text-rose-300">
              ⚠ served {proof?.served.join(", ")} — never granted
            </p>
          )}
          {proof?.stale && (
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
            onClick={onRotate}
            className="font-jetbrains text-[11px] text-cyan-300/80 transition hover:text-cyan-200 disabled:cursor-not-allowed disabled:text-white/30">
            {rotating === k.id ? "rotating…" : "rotate"}
          </button>
          {/* Secretless by necessity: the secret was shown once and is
              gone, so this re-measures the posture the proof depends on
              — not the scope matrix, which would need the key itself. */}
          <button
            onClick={onReprove}
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
            onClick={onToggleAgent}
            aria-expanded={agentOpen}
            title="Regenerate this key's agent install block (MCP server config or tool schema) from its capability manifest. No secret needed."
            className="font-jetbrains ml-3 text-[11px] text-cyan-300/60 transition hover:text-cyan-200">
            {agentOpen ? "hide agent config" : "agent config"}
          </button>
          {/* Revoke disappears once the key is revoked (it is already
              dead, and the backend is idempotent about it); rotate
              stays clickable so the backend's 409 — which states the
              reason — is the answer a user gets. */}
          {!k.revoked && (
            <button
              onClick={onRevoke}
              disabled={killing !== null}
              title="Stop this key authenticating, but keep it listed and auditable — the fix for a leak."
              className="font-jetbrains ml-3 text-[11px] text-white/45 transition hover:text-rose-300 disabled:cursor-not-allowed disabled:text-white/25">
              {killing === `${k.id}:revoke` ? "revoking…" : "revoke"}
            </button>
          )}
          <button
            onClick={onDestroy}
            disabled={killing !== null}
            title="Delete the key AND its audit record. Permanent."
            className="font-jetbrains ml-3 text-[11px] text-rose-300/70 transition hover:text-rose-200 disabled:cursor-not-allowed disabled:text-white/25">
            {killing === `${k.id}:destroy` ? "destroying…" : "destroy"}
          </button>
        </td>
      </tr>
      {agentOpen && (
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
    </>
  );
}
