// Speaker Sign-Off — the state machine and the link secret.
//
// These are the guarantees a type checker cannot make: that a legacy vault row
// (written before sign-off existed) renders exactly as it did, that an expired
// or withdrawn grant reads like a revoked one, and that the invite link cannot
// be reached with the voice id alone.

import { describe, expect, it, vi } from "vitest";

// Firebase never initializes in a test run (no config) — getAuth throws on an
// absent API key, which would fail this file at import time. The vault's pure
// helpers and its firebaseReady short-circuits are what is under test here.
vi.mock("@/lib/firebase", () => ({
  db: {}, auth: {}, googleProvider: {}, firebaseReady: false,
}));


import {
  declinedSignoff, expiryMs, isConsentBlocked, newSignoffToken, newVerificationPhrase,
  pendingSignoff, signedSignoff, signoffBadge, signoffLink, signoffState, tokenMatches,
  withdrawnSignoff, type Signoff, type VaultEntry,
} from "./voiceVault";

const legacyEntry: VaultEntry = {
  voice_id: "v1", character_id: "c1", character_name: "Nova", emotion: "calm",
  created: "2026-01-01T00:00:00.000Z", revoked: false,
  consent: {
    method: "uploaded", statement: "…", attestedBy: "owner", attestedEmail: "o@example.com",
  },
};

describe("legacy vault entries", () => {
  it("render exactly as before — self-attested, no badge, not blocked", () => {
    const state = signoffState(legacyEntry.consent.signoff);
    expect(state).toBe("self");
    expect(signoffBadge(state)).toBeNull();
    expect(isConsentBlocked(state)).toBe(false);
  });

  it("treats an explicitly self-attested record the same as an absent one", () => {
    const s = { status: "self", token: "t", phrase: "p" } as Signoff;
    expect(signoffState(s)).toBe("self");
    expect(signoffBadge("self")).toBeNull();
  });
});

describe("sign-off state machine", () => {
  it("round-trips request → sign → withdraw, and a withdrawal reads like a revoke", () => {
    const pending = pendingSignoff("2026-07-30T10:00:00.000Z");
    expect(pending.status).toBe("pending");
    expect(signoffState(pending)).toBe("pending");
    expect(signoffBadge("pending")?.tone).toBe("pending");
    expect(isConsentBlocked("pending")).toBe(false);

    const signed = signedSignoff(pending, {
      speakerUid: "spk", speakerEmail: "s@example.com",
      scope: { purpose: " narration ", exclusions: ["political content"] },
      phraseRecorded: true, phraseSeconds: 7, at: "2026-07-30T11:00:00.000Z",
    });
    expect(signoffState(signed)).toBe("signed");
    // the phrase + token survive the grant: the same link must not become a
    // second, different request
    expect(signed.phrase).toBe(pending.phrase);
    expect(signed.token).toBe(pending.token);
    expect(signed.scope?.purpose).toBe("narration"); // trimmed
    expect(signoffBadge("signed")).toEqual({ label: "speaker-signed", tone: "strong" });

    const withdrawn = withdrawnSignoff(signed, "2026-08-01T00:00:00.000Z");
    expect(signoffState(withdrawn)).toBe("withdrawn");
    expect(isConsentBlocked(signoffState(withdrawn))).toBe(true);
    expect(signoffBadge("withdrawn")?.label).toContain("action required");
    // the signed record is kept, not deleted — provenance survives withdrawal
    expect(withdrawn.speakerUid).toBe("spk");
    expect(withdrawn.signedAt).toBe("2026-07-30T11:00:00.000Z");
  });

  it("re-granting after a withdrawal clears the strike instead of freezing it", () => {
    const again = signedSignoff(withdrawnSignoff(
      signedSignoff(pendingSignoff(), { speakerUid: "spk", speakerEmail: null }),
    ), { speakerUid: "spk", speakerEmail: null });
    expect(again.withdrawnAt).toBeUndefined();
    expect(signoffState(again)).toBe("signed");
  });

  it("expires a grant the day after its date, not at midnight before it", () => {
    const base = signedSignoff(pendingSignoff(), { speakerUid: "s", speakerEmail: null });
    const s = { ...base, scope: { expiresAt: "2026-07-30" } };
    expect(signoffState(s, Date.parse("2026-07-30T22:00:00.000Z"))).toBe("signed");
    expect(signoffState(s, Date.parse("2026-07-31T00:00:01.000Z"))).toBe("expired");
    expect(isConsentBlocked("expired")).toBe(true);
    // an unparseable date must not silently kill a live consent
    expect(signoffState({ ...base, scope: { expiresAt: "whenever" } })).toBe("signed");
    expect(expiryMs(undefined)).toBeNull();
  });

  it("keeps a declined request answerable — the owner may ask again", () => {
    const d = declinedSignoff(pendingSignoff(), { uid: "spk", email: "s@example.com" });
    expect(signoffState(d)).toBe("declined");
    expect(signoffBadge("declined")?.tone).toBe("alert");
    expect(isConsentBlocked("declined")).toBe(false);
  });
});

describe("the invite link is the only way in", () => {
  it("mints a long random token, different every time", () => {
    const a = newSignoffToken();
    const b = newSignoffToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(24);
  });

  it("carries voice, owner and token — the voice id alone opens nothing", () => {
    const url = signoffLink("https://gravitone.test/", "owner uid", "v/1", "tok");
    expect(url).toBe("https://gravitone.test/s/v%2F1?o=owner%20uid&k=tok");
  });

  it("refuses a wrong, short, empty or absent token", () => {
    expect(tokenMatches("abc123", "abc123")).toBe(true);
    expect(tokenMatches("abc123", "abc124")).toBe(false);
    expect(tokenMatches("abc123", "abc")).toBe(false);
    expect(tokenMatches("abc123", "")).toBe(false);
    expect(tokenMatches("abc123", null)).toBe(false);
    expect(tokenMatches(undefined, "abc123")).toBe(false);
    // a legacy row has no signoff at all — its "token" is undefined and must
    // never match, or /s would open on any voice ever cloned
    expect(tokenMatches(legacyEntry.consent.signoff?.token, "anything")).toBe(false);
  });

  it("gives the speaker a phrase to read, not an empty ritual", () => {
    const p = newVerificationPhrase();
    expect(p.length).toBeGreaterThan(20);
    expect(newVerificationPhrase()).not.toBe(p);
  });
});
