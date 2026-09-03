"use client";

// Where a proof LIVES. The service's key model is deliberately not grown for
// this: an attestation is a statement about a deployment at a moment in time,
// not a property of the key, and storing it next to the key would invite
// reading it as one. It is kept studio-side, in this browser, in the same
// per-slot localStorage shape `lib/mintKey.ts` already uses.
//
// The consequence is stated wherever a proof is shown: a proof is this
// browser's memory of a probe it ran. Another browser sees declared-only chips,
// which is honest — it has not proved anything.
//
// STALENESS IS THE WHOLE RISK. A stored verdict is true about the deployment as
// it was when the probe ran; the moment `TTS_API_KEY` changes on the box it can
// become a lie. So (a) every record carries `checkedAt` and every proven chip
// renders it, and (b) `restate` compares a fresh posture against the posture
// the proof was taken under and marks the record stale when they differ — a
// least-privilege matrix proved on an enforcing box means nothing on an open one.

import type { Posture, Sweep } from "./probes";

export type Attestation = {
  keyId: string;
  /** The posture measured in the same run that produced these verdicts. */
  posture: Posture;
  checkedAt: string;
  proven: string[];
  correctlyRefused: string[];
  grantedButRefused: string[];
  /** Scopes this key was NOT granted and was served anyway. Never empty
   *  quietly — the ledger turns this into an alert. */
  served: string[];
  /** False when no positive probe was served, so the refusals below prove the
   *  key is unrecognised rather than that scoping works (service/auth.py
   *  answers 401 for both). */
  negativesConclusive: boolean;
  /** Set by `restate` when the deployment's posture no longer matches the one
   *  this proof was taken under. A stale proof shows no proven chips. */
  stale?: boolean;
  /** When the posture was last re-measured for this key (the re-prove action). */
  restatedAt?: string;
};

const slot = (keyId: string) => `gravitone.keyProof.${keyId}`;

export function summarize(keyId: string, sweep: Sweep): Attestation {
  const by = (v: string) => sweep.probes.filter((p) => p.verdict === v).map((p) => p.scope);
  return {
    keyId,
    posture: sweep.posture,
    checkedAt: sweep.checkedAt,
    proven: by("proven"),
    correctlyRefused: by("correctly-refused"),
    grantedButRefused: by("granted-but-refused"),
    served: by("REFUSED-SCOPE-SERVED"),
    negativesConclusive: sweep.negativesConclusive,
  };
}

export function readAttestation(keyId: string): Attestation | null {
  try {
    const raw = localStorage.getItem(slot(keyId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Attestation;
    // A half-written or hand-edited slot must not be rendered as a proof.
    if (!parsed || typeof parsed.checkedAt !== "string" || !Array.isArray(parsed.proven)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeAttestation(keyId: string, sweep: Sweep): Attestation | null {
  const record = summarize(keyId, sweep);
  try {
    localStorage.setItem(slot(keyId), JSON.stringify(record));
  } catch {
    // Storage full or blocked: the sweep result is still shown in the reveal,
    // it just will not survive the dialog. Never pretend it was saved.
    return null;
  }
  return record;
}

export function forgetAttestation(keyId: string): void {
  try {
    localStorage.removeItem(slot(keyId));
  } catch {
    /* nothing to clean up if storage is unavailable */
  }
}

/** Re-prove, secretless: fold a freshly measured posture into a stored record.
 *  The secret is long gone by now (shown once), so this cannot re-run the scope
 *  sweep — it re-measures the ONE thing that needs no credential, and says so.
 *  A posture that changed invalidates the matrix rather than sitting beside it. */
export function restate(keyId: string, posture: Posture, at: string): Attestation | null {
  const prior = readAttestation(keyId);
  if (!prior) return null;
  const next: Attestation = {
    ...prior,
    restatedAt: at,
    stale: prior.stale === true || posture !== prior.posture,
    posture,
  };
  try {
    localStorage.setItem(slot(keyId), JSON.stringify(next));
  } catch {
    return next; // in-memory truth is still better than a stale render
  }
  return next;
}

/** True when this record's scope verdicts may still be shown as proof. */
export function provenScopes(record: Attestation | null): string[] {
  if (!record || record.stale) return [];
  // A proof taken on an OPEN deployment proves nothing about privilege: every
  // scope is served to everyone, granted or not.
  if (record.posture !== "enforced") return [];
  return record.proven;
}
