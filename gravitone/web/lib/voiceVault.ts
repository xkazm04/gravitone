"use client";

// Personal Voice Vault — provenance for every cloned voice, bound to the
// authenticated identity. Each clone gets a consent attestation (who
// attested, how the audio was obtained, when) stored at
// users/{uid}/voices/{voice_id} in Firestore. The vault is a provenance
// ledger the profile renders as "My Voices"; server-side enforcement of
// ownership on the TTS API is a follow-up (needs admin-side auth).

import {
  collection, deleteField, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc,
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

// ---------------------------------------------------------------------------
// Speaker Sign-Off — consent as a two-party record.
//
// Self-attestation stays the DEFAULT; sign-off is the upgrade that earns the
// strongest badge the vault has. The owner asks (status "pending" + a random
// verification phrase + an unguessable token), the speaker opens /s/{voiceId}
// with that token, signs in as themselves, reads the phrase back, and grants a
// scoped consent. The grant is mirrored at speakers/{speakerUid}/consents/{id}
// so the speaker keeps a dashboard of every voice cloned from them.
//
// HONEST LIMIT, stated in the UI too: enforcement is client-side in v1. The
// engine has no identity, so a withdrawal is only as strong as an honest
// client until it does. The record is real; the padlock is not.
// ---------------------------------------------------------------------------

export type SignoffStatus = "self" | "pending" | "signed" | "declined";

/** What the SPEAKER granted, on their terms. All optional — a grant with no
 *  scope is an unrestricted one, and we say so rather than implying limits. */
export type SignoffScope = {
  purpose?: string;
  /** ISO date (YYYY-MM-DD) or full ISO timestamp; absent = no expiry. */
  expiresAt?: string;
  exclusions?: string[];
};

export type Signoff = {
  status: SignoffStatus;
  /** Random, unguessable. The /s route requires voiceId AND this token — the
   *  voice id alone is not a secret (it travels in share links and API calls). */
  token: string;
  /** The sentence the speaker reads back, so the grant is bound to a live human. */
  phrase: string;
  requestedAt?: string;
  speakerUid?: string;
  speakerEmail?: string | null;
  scope?: SignoffScope;
  signedAt?: string;
  declinedAt?: string;
  /** Set by the speaker's withdraw. Owner's row flips to "action required". */
  withdrawnAt?: string;
  /** The phrase was recorded in the browser at grant time. The recording is not
   *  uploaded (there is no audio store yet) — the RECORD is the artifact. */
  phraseRecorded?: boolean;
  phraseSeconds?: number;
};

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
    /** Absent on every entry written before sign-off existed — legacy rows must
     *  render EXACTLY as they did (self-attested, no badge). */
    signoff?: Signoff;
  };
};

/** The speaker's view of one grant (speakers/{uid}/consents/{voiceId}). */
export type SpeakerConsent = {
  voice_id: string;
  ownerUid: string;
  ownerEmail: string | null;
  character_name: string;
  emotion: string;
  phrase: string;
  scope?: SignoffScope;
  signedAt: string;
  withdrawnAt?: string;
};

/** Derived state — what the row actually IS right now, expiry included.
 *  "self" means no sign-off was ever requested: absent = invisible. */
export type SignoffState =
  | "self" | "pending" | "signed" | "declined" | "expired" | "withdrawn";

/** Expiry is a date the speaker set; treat a bare YYYY-MM-DD as end-of-day so a
 *  grant valid "until the 5th" does not die at midnight on the 4th→5th. */
export function expiryMs(expiresAt?: string): number | null {
  if (!expiresAt) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(expiresAt) ? `${expiresAt}T23:59:59.999Z` : expiresAt;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function signoffState(signoff?: Signoff | null, now: number = Date.now()): SignoffState {
  if (!signoff || !signoff.status) return "self";
  if (signoff.withdrawnAt) return "withdrawn";
  if (signoff.status === "signed") {
    const exp = expiryMs(signoff.scope?.expiresAt);
    if (exp !== null && exp < now) return "expired";
    return "signed";
  }
  return signoff.status === "self" ? "self" : signoff.status;
}

/** Expired or withdrawn consent renders exactly like a revoked voice —
 *  struck-through and unplayable — and asks the owner to finish the job. */
export function isConsentBlocked(state: SignoffState): boolean {
  return state === "expired" || state === "withdrawn";
}

export type SignoffBadge = { label: string; tone: "strong" | "pending" | "alert" };

/** null = render nothing. The self-attested default has no badge; the strongest
 *  badge is EARNED, never the default. */
export function signoffBadge(state: SignoffState): SignoffBadge | null {
  switch (state) {
    case "signed": return { label: "speaker-signed", tone: "strong" };
    case "pending": return { label: "sign-off pending", tone: "pending" };
    case "declined": return { label: "sign-off declined", tone: "alert" };
    case "expired": return { label: "consent expired — action required", tone: "alert" };
    case "withdrawn": return { label: "consent withdrawn — action required", tone: "alert" };
    default: return null;
  }
}

const PHRASE_WORDS = [
  "amber", "harbor", "lantern", "meadow", "quartz", "ripple", "saffron", "thistle",
  "velvet", "willow", "cobalt", "ember", "fathom", "gossamer", "juniper", "kestrel",
];

function randomInts(n: number): number[] {
  const out = new Uint32Array(n);
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c?.getRandomValues) c.getRandomValues(out);
  // Math.random fallback keeps the flow working in a non-secure context; the
  // token is a link secret, not a credential the engine checks.
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 0xffffffff);
  return Array.from(out);
}

/** 128 bits of link secret, base36. Guessing it is the only way to reach a
 *  sign-off page you were not sent. */
export function newSignoffToken(): string {
  return randomInts(4).map((n) => n.toString(36).padStart(7, "0")).join("");
}

export function newVerificationPhrase(): string {
  const r = randomInts(4);
  const words = r.slice(0, 3).map((n) => PHRASE_WORDS[n % PHRASE_WORDS.length]);
  return `My voice, my choice: ${words.join(" ")} ${(r[3] % 900) + 100}.`;
}

/** Length-safe comparison — no early exit on the first wrong character. */
export function tokenMatches(expected: string | undefined, given: string | null | undefined): boolean {
  if (!expected || !given || expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// --- pure record builders (the state machine; the writers below persist them) --

export function pendingSignoff(now: string = new Date().toISOString()): Signoff {
  return { status: "pending", token: newSignoffToken(), phrase: newVerificationPhrase(), requestedAt: now };
}

export function signedSignoff(
  prev: Signoff,
  grant: {
    speakerUid: string; speakerEmail: string | null; scope?: SignoffScope;
    phraseRecorded?: boolean; phraseSeconds?: number; at?: string;
  },
): Signoff {
  const scope: SignoffScope = {};
  if (grant.scope?.purpose?.trim()) scope.purpose = grant.scope.purpose.trim();
  if (grant.scope?.expiresAt) scope.expiresAt = grant.scope.expiresAt;
  if (grant.scope?.exclusions?.length) scope.exclusions = grant.scope.exclusions;
  const next: Signoff = {
    ...prev,
    status: "signed",
    speakerUid: grant.speakerUid,
    speakerEmail: grant.speakerEmail,
    signedAt: grant.at ?? new Date().toISOString(),
    phraseRecorded: Boolean(grant.phraseRecorded),
  };
  if (grant.phraseSeconds != null) next.phraseSeconds = grant.phraseSeconds;
  if (Object.keys(scope).length) next.scope = scope;
  // A re-grant after a withdrawal is a fresh consent: the old withdrawal must
  // not keep the row struck-through forever.
  delete next.withdrawnAt;
  delete next.declinedAt;
  return next;
}

export function declinedSignoff(prev: Signoff, speaker: { uid: string; email: string | null }, at?: string): Signoff {
  return {
    ...prev, status: "declined", speakerUid: speaker.uid, speakerEmail: speaker.email,
    declinedAt: at ?? new Date().toISOString(),
  };
}

export function withdrawnSignoff(prev: Signoff, at?: string): Signoff {
  return { ...prev, withdrawnAt: at ?? new Date().toISOString() };
}

/** The invite. Copy-a-link only in v1 — no email is sent, and the UI says so. */
export function signoffLink(origin: string, ownerUid: string, voiceId: string, token: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/s/${encodeURIComponent(voiceId)}?o=${encodeURIComponent(ownerUid)}&k=${encodeURIComponent(token)}`;
}

export type NewVaultVoice = {
  voice_id: string;
  character_id: string;
  character_name: string;
  emotion: string;
};

/** Outcome of a provenance write batch, so callers can warn when a consent
 *  receipt failed to persist without the clone flow itself throwing. */
export type OwnershipResult = { saved: number; failed: number };

/** Persist ownership + consent for freshly cloned voices. Never throws —
 *  provenance must not break the clone flow — but RETURNS a summary so the
 *  caller can surface "consent receipt not saved" instead of losing it
 *  silently. */
export async function recordVoiceOwnership(
  user: { uid: string; email: string | null },
  voices: NewVaultVoice[],
  method: ConsentMethod,
): Promise<OwnershipResult> {
  if (!firebaseReady || voices.length === 0) return { saved: 0, failed: 0 };
  const created = new Date().toISOString();
  const results = await Promise.allSettled(
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
      }),
    ),
  );
  let failed = 0;
  results.forEach((res, i) => {
    if (res.status === "rejected") {
      failed++;
      console.warn("[voiceVault] record failed", voices[i].voice_id, res.reason);
    }
  });
  return { saved: voices.length - failed, failed };
}

export async function listVault(uid: string): Promise<VaultEntry[]> {
  if (!firebaseReady) return [];
  const snap = await getDocs(collection(db, "users", uid, "voices"));
  return snap.docs
    .map((d) => d.data() as VaultEntry)
    .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
}

/** Mark a vault entry revoked (the voice file itself is deleted via the API).
 *  Returns false if the ledger update failed, so the caller can warn that the
 *  vault is now out of sync with the deleted voice instead of swallowing it. */
export async function markRevoked(uid: string, voiceId: string): Promise<boolean> {
  if (!firebaseReady) return true; // no vault in open mode — nothing to record
  try {
    await updateDoc(doc(db, "users", uid, "voices", voiceId), {
      revoked: true,
      revokedAt: serverTimestamp(),
      // the reference is gone from the engine; drop any stale sharing state
      sharing: deleteField(),
    });
    return true;
  } catch (e) {
    console.warn("[voiceVault] revoke mark failed", voiceId, e);
    return false;
  }
}

// --- sign-off persistence ---------------------------------------------------

const ownerVoiceRef = (ownerUid: string, voiceId: string) =>
  doc(db, "users", ownerUid, "voices", voiceId);
const speakerConsentRef = (speakerUid: string, voiceId: string) =>
  doc(db, "speakers", speakerUid, "consents", voiceId);

/** Owner asks the speaker to sign. Returns the record (phrase + token) so the
 *  caller can show the phrase and the copyable link immediately. Throws on a
 *  failed write — a link the speaker cannot use must never look sent. */
export async function requestSignoff(ownerUid: string, voiceId: string): Promise<Signoff> {
  const signoff = pendingSignoff();
  if (!firebaseReady) return signoff;
  await updateDoc(ownerVoiceRef(ownerUid, voiceId), { "consent.signoff": signoff });
  return signoff;
}

/** Read ONE vault row by owner + voice id. `get`, never `list` — a link holder
 *  can reach the voice they were sent and nothing else in the owner's vault. */
export async function loadVaultEntry(ownerUid: string, voiceId: string): Promise<VaultEntry | null> {
  if (!firebaseReady) return null;
  const snap = await getDoc(ownerVoiceRef(ownerUid, voiceId));
  return snap.exists() ? (snap.data() as VaultEntry) : null;
}

export type GrantInput = {
  ownerUid: string;
  entry: VaultEntry;
  speaker: { uid: string; email: string | null };
  scope?: SignoffScope;
  phraseRecorded?: boolean;
  phraseSeconds?: number;
};

/** Write the attestation to BOTH sides: the owner's vault row (so their ledger
 *  carries the badge) and the speaker's own mirror (so they keep a dashboard).
 *  The owner write is the one that must land — if the mirror fails the speaker
 *  is told their dashboard is out of sync rather than being shown a lie. */
export async function grantSignoff(input: GrantInput): Promise<{ owner: boolean; mirror: boolean }> {
  const prev = input.entry.consent?.signoff;
  if (!prev) throw new Error("this voice has no open sign-off request");
  const next = signedSignoff(prev, {
    speakerUid: input.speaker.uid, speakerEmail: input.speaker.email, scope: input.scope,
    phraseRecorded: input.phraseRecorded, phraseSeconds: input.phraseSeconds,
  });
  if (!firebaseReady) return { owner: true, mirror: true };
  await updateDoc(ownerVoiceRef(input.ownerUid, input.entry.voice_id), { "consent.signoff": next });
  const mirror: SpeakerConsent = {
    voice_id: input.entry.voice_id,
    ownerUid: input.ownerUid,
    ownerEmail: input.entry.consent?.attestedEmail ?? null,
    character_name: input.entry.character_name,
    emotion: input.entry.emotion,
    phrase: next.phrase,
    signedAt: next.signedAt!,
    ...(next.scope ? { scope: next.scope } : {}),
  };
  try {
    await setDoc(speakerConsentRef(input.speaker.uid, input.entry.voice_id), {
      ...mirror, signedTs: serverTimestamp(),
    });
    return { owner: true, mirror: true };
  } catch (e) {
    console.warn("[voiceVault] speaker mirror write failed", input.entry.voice_id, e);
    return { owner: true, mirror: false };
  }
}

export async function declineSignoff(
  ownerUid: string, entry: VaultEntry, speaker: { uid: string; email: string | null },
): Promise<void> {
  const prev = entry.consent?.signoff;
  if (!prev) throw new Error("this voice has no open sign-off request");
  if (!firebaseReady) return;
  await updateDoc(ownerVoiceRef(ownerUid, entry.voice_id), {
    "consent.signoff": declinedSignoff(prev, speaker),
  });
}

export async function listSpeakerConsents(speakerUid: string): Promise<SpeakerConsent[]> {
  if (!firebaseReady) return [];
  const snap = await getDocs(collection(db, "speakers", speakerUid, "consents"));
  return snap.docs
    .map((d) => d.data() as SpeakerConsent)
    .sort((a, b) => (b.signedAt ?? "").localeCompare(a.signedAt ?? ""));
}

/** The speaker takes it back. Both sides are stamped: the mirror so their own
 *  dashboard is honest, the owner's row so it flips to "action required".
 *  Returns which halves landed — a withdrawal the owner never sees is the one
 *  failure mode this feature cannot swallow. */
export async function withdrawConsent(
  speakerUid: string, consent: SpeakerConsent,
): Promise<{ mirror: boolean; owner: boolean }> {
  if (!firebaseReady) return { mirror: true, owner: true };
  const at = new Date().toISOString();
  let mirror = false, owner = false;
  try {
    await updateDoc(speakerConsentRef(speakerUid, consent.voice_id), { withdrawnAt: at });
    mirror = true;
  } catch (e) {
    console.warn("[voiceVault] withdraw mirror failed", consent.voice_id, e);
  }
  try {
    await updateDoc(ownerVoiceRef(consent.ownerUid, consent.voice_id), {
      "consent.signoff.withdrawnAt": at,
    });
    owner = true;
  } catch (e) {
    console.warn("[voiceVault] withdraw owner-row failed", consent.voice_id, e);
  }
  return { mirror, owner };
}
