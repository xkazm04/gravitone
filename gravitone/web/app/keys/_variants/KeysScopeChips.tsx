"use client";

import { provenScopes, type Attestation } from "./attestation";
import { relTime } from "./data";

/** Scope chips, in the honesty grammar the page already uses for revoked rows:
 *  SOLID = proved by a probe that watched this deployment serve it, with the
 *  timestamp of that probe; OUTLINED (dashed) = declared only — a string
 *  somebody typed, never observed. A proof is this browser's memory of a sweep
 *  run at mint/rotate (see attestation.ts), and it stops counting when the
 *  posture changes underneath it. */
export default function ScopeChips({ scopes, proof }: { scopes: string[]; proof: Attestation | null }) {
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
