# REPORT — SIGN-OFF (Speaker Sign-Off), Batch 3

> Saved by the orchestrator from the builder's inline report.

**Status: done.** tsc clean; full vitest 525/527 — own 24 tests green; the 2 reds are
PROVING/VERIFIED in-flight files (KeysLedger.test.tsx, lib/serviceHeaders.test.ts), untouched
by this builder — re-verify at final gates.

Files: `web/lib/voiceVault.ts` (E3 Signoff + 128-bit token, pure state machine
pending/signed/declined/expired/withdrawn, signoffBadge, tokenMatches, signoffLink,
requestSignoff/loadVaultEntry/grantSignoff(dual-write)/declineSignoff/listSpeakerConsents/
withdrawConsent); `app/profile/MyVoices.tsx` (badge + request + phrase + copy-link),
`VoicesOfMine.tsx` (new speaker-side panel), `page.tsx`; `app/s/[voiceId]/{page,SignoffFlow,
PhraseRecorder}.tsx` (new; phrase audio never uploaded); `components/ui/UserMenu.tsx` (badge).
Tests: voiceVault.test.ts, MyVoices.test.tsx, SignoffFlow.test.tsx.

## HOOK — Firestore rules (NOT applied; user must deploy)
```
match /speakers/{speakerUid}/consents/{voiceId} {
  allow get, list: if request.auth.uid == speakerUid;          // speaker's own dashboard
  allow create, update: if request.auth.uid == speakerUid;     // speaker-owned write
  allow get: if request.auth.uid == resource.data.ownerUid;    // owner may read one, never list
  allow delete: if false;                                      // withdrawals stamp, never erase
}
match /users/{ownerUid}/voices/{voiceId} {
  allow read, write: if request.auth.uid == ownerUid;
  allow get: if request.auth != null;   // REQUIRED by /s: link holder reads ONE row
  allow list: if request.auth.uid == ownerUid;  // never enumerable by strangers
  allow update: if request.auth != null
    && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['consent']);
}
```
Token secrecy is client-checked (tokenMatches) — the `get` rule is deliberately
broad-but-unguessable; the UI states client-side-v1 enforcement plainly.
