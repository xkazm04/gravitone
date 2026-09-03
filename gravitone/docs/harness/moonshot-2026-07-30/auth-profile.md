# Moonshots — Auth & Profile (web) — 2026-07-30

Context read: `web/lib/useAuth.tsx`, `web/lib/firebase.ts`, `web/lib/mintKey.ts`,
`web/lib/voiceVault.ts`, `web/app/profile/page.tsx`, `web/app/profile/MyVoices.tsx`,
`web/components/ui/UserMenu.tsx`, plus grounding in `service/diarize.py`,
`service/voices.py`, `docs/harness/followups-2026-07-10.md`.

Current scaffold in one line: Google sign-in → `users/{uid}` Firestore doc →
auto-minted tts-scoped key (localStorage) → a **client-written** consent ledger
at `users/{uid}/voices/{voice_id}` where consent is a *one-party self-attestation*
("I own this voice or hold the speaker's consent"), and the engine has no identity
at all. Both moonshots below attack that: identity today is an account label; it
should be a **verifiable claim about a human voice**.

---

## M1. The Voiceprint Registry — enroll your voice once, and no account can clone it but yours

- **Tier**: 1 (10x category-defining)
- **Category**: platform
- **Impact**: Turns the vault from a self-declared paper trail into an *enforced*
  biometric one: a 15-second enrollment take at sign-in makes the account's
  voiceprint, and every subsequent clone (uploaded or ingested) is speaker-matched
  against enrolled prints — audio that is provably someone *else's* enrolled voice
  is blocked before an embedding is ever written.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: Every voice-cloning product in the market asks the
  cloner to tick a consent box and hopes. Nobody can *detect* impersonation at
  clone time because nobody holds a registry of voices bound to identities. The
  registry is a compounding asset with real network effects — each enrollment
  makes the shield stronger for every other member, and the same index answers the
  inverse, far more viral question: *"has anyone cloned me?"* — a signed
  "not-in-registry / matched" answer that voice actors, podcasters and executives
  will create accounts purely to get. The pieces are already on the box:
  `service/diarize.py` vendors a sherpa-onnx `SpeakerEmbeddingExtractorConfig`
  (~29 MB, CPU-only) and already reasons about the fact that expressive TTS moves
  a speaker embedding more than two real people differ.
- **Path to implementation**:
  1. **In the current scaffold**: add an "identity voiceprint" card to
     `app/profile/page.tsx` beside `MyVoices` — reuse the guided recorder to
     capture a 15s enrollment take, POST it to a new `/api/voiceprint/enroll`,
     and store the returned 192-dim vector + hash at `users/{uid}` (a
     `voiceprint` field, written through the same `updateProfile` path).
  2. Service side: extract `speaker_embedding(wav) -> vector` out of
     `diarize.py` into a tiny reusable module; expose `POST /v1/voiceprint`
     (embed) and `POST /v1/voiceprint/match` (cosine vs a supplied set of
     vectors). Stateless, so no multi-tenant decision is needed yet.
  3. Gate the clone flows: before `voices.py` clone / `ingest.py` export, the web
     client sends the source audio to `/match` with the caller's own enrolled
     print → **self-match = auto-attested** (`consent.method: "verified-self"`,
     the strongest tier the ledger has ever carried) and stamp it into
     `voiceVault.recordVoiceOwnership`.
  4. Add the cross-account check: a `voiceprints/{hash}` top-level Firestore
     collection (vector + uid, rules = read-by-match-query only, never listable)
     so a clone whose audio matches a *different* uid's print is refused with a
     "this voice is enrolled to another account — get their sign-off" path
     (hands straight to M2).
  5. Ship the inverse product: `/voiceprint` public page — record 15s, get a
     signed match report against your own enrolled print and against the vault's
     cloned voices. This is the acquisition surface.
  6. Calibrate: publish the threshold + false-accept/false-reject numbers the way
     `/benchmarks` publishes latency, with a human appeal path on every refusal.
- **Dependencies**: sherpa-onnx speaker-embedding model (already downloaded by
  the diarizer path); a Firestore rules change for the match collection; the
  guided recorder component; agreement that a *biometric* is stored (vector +
  hash only, never the audio).
- **Risks**: Biometric data is a compliance category of its own (GDPR Art. 9 /
  BIPA) — needs explicit opt-in copy and a hard delete path. False rejects are
  brutal UX (family members, poor mics); must fail *open with a warning* on
  low-confidence rather than block. Cross-account matching only works if the
  match query runs somewhere trusted — an all-client implementation is
  bypassable, so v1 is a friction/deterrent layer, honest about that in the copy.
- **What changes if we ship it**: Gravitone stops being "the cheap local
  ElevenLabs" and becomes the place where a voice has an *owner of record* —
  the only cloning stack that can refuse an impersonation at the moment it is
  attempted, and tell you when someone tried.

---

## M2. Speaker Sign-Off — consent becomes a two-party, revocable protocol with the speaker as a first-class account

- **Tier**: 1 (10x category-defining)
- **Category**: functionality
- **Impact**: Replaces the cloner's self-attestation with a signed record from the
  *speaker*: they open a link, sign in as themselves, read a verification phrase,
  and grant scoped consent — and they keep a permanent dashboard of every voice
  cloned from them, with a revoke button that propagates into the cloner's vault
  and deletes the embedding.
- **Feasibility**: high
- **Time-horizon**: weeks (v1 sign-off) → months (speaker dashboard + propagating
  revocation)
- **Why it's a moonshot**: It inverts who the product serves. Every consent UI in
  this market is a checkbox the *cloner* clicks about a person who isn't in the
  room; making the speaker an authenticated counterparty produces an artifact that
  actually survives a dispute — and it creates the loop the product has no other
  route to: **every clone invites a human who doesn't have an account yet**, who
  arrives with a self-interested reason to sign in (control over their own voice),
  and who then finds a vault, a roster and a recorder waiting. That is viral
  acquisition through the trust layer rather than through a share link. The
  scaffold is unusually close: `useAuth` already handles a redirect sign-in path,
  the vault already stores `attestedBy`/`attestedEmail`, and `markRevoked` already
  separates "embedding deleted" from "provenance kept".
- **Path to implementation**:
  1. **In the current scaffold**: extend the `VaultEntry.consent` shape with a
     `signoff: { status: "self" | "pending" | "signed" | "declined", speakerUid?,
     speakerEmail?, phrase, signedAt }` and render its state as a badge per row in
     `app/profile/MyVoices.tsx` — a "request sign-off" action that writes
     `status: "pending"` + a random verification phrase. Zero backend work; the
     ledger starts carrying the state immediately.
  2. Add `/s/[voiceId]` (mirroring the existing `/t/[id]` and `/r/[id]` public
     routes): the speaker hears the cloned voice and the original snippet, signs
     in with Google via the existing `signIn()`, records the verification phrase,
     and their attestation is written under both `users/{owner}/voices/{id}` and a
     `speakers/{speakerUid}/consents/{id}` mirror. The recorded phrase closes the
     deferred "verification-phrase audio" crumb as a by-product — but the record,
     not the recording, is the point.
  3. Scope the grant on the speaker's terms: purpose text, expiry date, and an
     explicit "no political / no endorsement" toggle set — stored on the consent,
     surfaced everywhere the voice appears (roster, packs, share pages).
  4. Build the **speaker side of the profile**: `/profile` gains a "Voices of
     mine" panel driven by `speakers/{uid}/consents` — one dashboard listing who
     cloned them, under what scope, until when, with per-entry withdraw. Same
     component vocabulary as `MyVoices`, opposite direction.
  5. Make withdrawal real: a withdraw writes `revokeRequested`, the owner's vault
     row flips to "consent withdrawn — action required", and expiry/withdrawal
     both drive the existing `DELETE /api/voices/{id}` + `markRevoked` pair.
     Expired-or-withdrawn voices render struck-through and unplayable exactly as
     revoked ones do today.
  6. Travel with the asset: fold the signed consent (and its scope) into the
     `.gravichar` manifest's empty license/creator fields so an imported pack
     arrives with its sign-off attached — a pack with no sign-off is visibly
     weaker than one that has it.
- **Dependencies**: a public route + Firestore rules for the `speakers/**`
  mirror (speaker-owned, owner-readable); the existing recorder; `packs.py`
  manifest fields; email delivery for the invite (or copy-a-link only in v1).
- **Risks**: A second user type doubles the auth surface — the invite link must be
  unguessable and must not leak the owner's other voices. Because enforcement
  still lives in the client, a withdrawal is only as strong as the honest client
  until the engine gains identity — v1 must say so plainly rather than overclaim.
  Sign-off adds friction to a flow that currently takes one checkbox; keep the
  self-attested path as the default and sign-off as the upgrade that unlocks the
  strongest badge.
- **What changes if we ship it**: The consent ledger stops being a promise the
  cloner made to themselves and becomes a two-party, expiring, revocable
  agreement — and every voice cloned on the platform becomes an invitation for the
  human behind it to join.
