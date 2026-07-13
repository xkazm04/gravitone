"use client";

// Personal Voice Vault — provenance for every cloned voice, bound to the
// authenticated identity. Each clone gets a consent attestation (who
// attested, how the audio was obtained, when) stored at
// users/{uid}/voices/{voice_id} in Firestore. The vault is a provenance
// ledger the profile renders as "My Voices"; server-side enforcement of
// ownership on the TTS API is a follow-up (needs admin-side auth).

import {
  collection, deleteField, doc, getDocs, serverTimestamp, setDoc, updateDoc,
} from "firebase/firestore";
import { db, firebaseReady } from "./firebase";

export type ConsentMethod = "self-recorded" | "uploaded" | "ingested";

export const CONSENT_STATEMENTS: Record<ConsentMethod, string> = {
  "self-recorded":
    "Recorded live in this browser by the signed-in user — the speaker is the attester.",
  uploaded:
    "Uploaded by the signed-in user, who attested they own this voice or hold the speaker's consent.",
  ingested:
    "Extracted from a recording the signed-in user submitted, attesting they hold the speaker's consent.",
};

export const CONSENT_PROMPT =
  "Consent check: do you own this voice, or have the speaker's explicit consent to clone it?\n\n" +
  "Your attestation (account + timestamp) is stored with the voice.";

export type VaultEntry = {
  voice_id: string;
  character_id: string;
  character_name: string;
  emotion: string;
  created: string;
  revoked: boolean;
  consent: {
    method: ConsentMethod;
    statement: string;
    attestedBy: string; // uid
    attestedEmail: string | null;
  };
};

export type NewVaultVoice = {
  voice_id: string;
  character_id: string;
  character_name: string;
  emotion: string;
};

/** Persist ownership + consent for freshly cloned voices. Never throws —
 *  provenance must not break the clone flow (failures are logged). */
export async function recordVoiceOwnership(
  user: { uid: string; email: string | null },
  voices: NewVaultVoice[],
  method: ConsentMethod,
): Promise<void> {
  if (!firebaseReady || voices.length === 0) return;
  const created = new Date().toISOString();
  await Promise.all(
    voices.map((v) =>
      setDoc(doc(db, "users", user.uid, "voices", v.voice_id), {
        ...v,
        created,
        createdAt: serverTimestamp(),
        revoked: false,
        consent: {
          method,
          statement: CONSENT_STATEMENTS[method],
          attestedBy: user.uid,
          attestedEmail: user.email,
        },
      }).catch((e) => console.warn("[voiceVault] record failed", v.voice_id, e)),
    ),
  );
}

export async function listVault(uid: string): Promise<VaultEntry[]> {
  if (!firebaseReady) return [];
  const snap = await getDocs(collection(db, "users", uid, "voices"));
  return snap.docs
    .map((d) => d.data() as VaultEntry)
    .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
}

/** Mark a vault entry revoked (the voice file itself is deleted via the API). */
export async function markRevoked(uid: string, voiceId: string): Promise<void> {
  if (!firebaseReady) return;
  await updateDoc(doc(db, "users", uid, "voices", voiceId), {
    revoked: true,
    revokedAt: serverTimestamp(),
    // the reference is gone from the engine; drop any stale sharing state
    sharing: deleteField(),
  }).catch((e) => console.warn("[voiceVault] revoke mark failed", voiceId, e));
}
