"use client";

// First-sign-in key minting. The backend's copy-once secret is kept in
// localStorage (per uid, this browser only) so "copy my key" works from the
// UserMenu and the profile panel; Firestore stores only id + prefix.

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
    const r = await fetch("/api/keys", {
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
