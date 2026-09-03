"use client";

// First-sign-in key minting. The backend's copy-once secret is kept in
// localStorage (per uid, this browser only) so "copy my key" works from the
// UserMenu and the profile panel; Firestore stores only id + prefix.
//
// TRADEOFF, kept deliberately: this ONE key is not copy-once. Persisting a
// plaintext credential is a real cost, and the alternatives are worse for the
// product — dropping the storage breaks "copy my API key" from the menu and the
// profile's ready-to-paste migration snippet, which is the 60-second-migration
// pitch; and re-minting on every visit would churn credentials behind the
// user's back. It is bounded instead: this browser only, this uid's slot only,
// and `clearStoredKey` wipes it on sign-out.
//
// What was NOT acceptable was the reveal modal telling users "this is the only
// time the full secret is shown" while this key was quietly re-displayable.
// `isStoredSecret` below lets a surface ask, so the copy can tell the truth
// instead of the storage being reversed in silence.

import { authedFetch } from "./authedFetch";

export type MintedKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  secret: string;
};

export type StoredKey = { secret: string; prefix: string };

const slot = (uid: string) => `gravitone.apiKey.${uid}`;

export function getStoredKey(uid: string): StoredKey | null {
  try {
    const raw = localStorage.getItem(slot(uid));
    return raw ? (JSON.parse(raw) as StoredKey) : null;
  } catch {
    return null;
  }
}

/** True when this exact secret is one this browser has saved — i.e. the user
 *  can re-copy it later from the profile panel or the user menu, so any
 *  "shown once, then gone" promise about it would be false.
 *
 *  Scans every `gravitone.apiKey.*` slot rather than taking a uid, so a surface
 *  can ask the question without depending on auth context. Returns false when
 *  storage is unavailable — the conservative answer is the once-only warning. */
export function isStoredSecret(secret: string): boolean {
  if (!secret) return false;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith("gravitone.apiKey.")) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      try {
        if ((JSON.parse(raw) as StoredKey)?.secret === secret) return true;
      } catch {
        /* a slot we didn't write, or half-written — not a match */
      }
    }
  } catch {
    /* storage unavailable — nothing is stored, so nothing is re-copyable */
  }
  return false;
}

/** Drop the stored copy-once secret for a uid. Called on sign-out so the
 *  plaintext credential does not outlive the session on a shared browser. */
export function clearStoredKey(uid: string): void {
  try {
    localStorage.removeItem(slot(uid));
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

export async function mintDefaultKey(uid: string, email: string | null): Promise<MintedKey | null> {
  try {
    const r = await authedFetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `default — ${email ?? uid.slice(0, 8)}`, scopes: ["tts"] }),
    });
    if (!r.ok) return null;
    const k = (await r.json()) as MintedKey;
    try {
      localStorage.setItem(slot(uid), JSON.stringify({ secret: k.secret, prefix: k.prefix }));
    } catch {
      /* storage unavailable — the profile panel can mint another */
    }
    return k;
  } catch {
    return null; // backend down — sign-in must never break on this
  }
}
