# Dual-scan Fix Wave 2 — Consent & data-integrity

> 4 commits, 9 findings closed (1 critical, 6 high, 2 medium).
> Gates: web `tsc` 0 errors, `next build` PASS, lint clean. Baseline preserved.
> With this wave, **both scan criticals are closed** (certify in W1, MyVoices revoke here).

## Commits

| # | Commit | Findings closed | Severity | Files |
|---|---|---|---|---|
| 1 | `ec98971` | revoke lies + vault writes unobservable | **critical**, high, medium | `lib/voiceVault.ts`, `profile/MyVoices.tsx` |
| 2 | `4fa45ef` | ownership dropped + speaker/commit unchecked | high, high, medium | `voices/new/page.tsx` |
| 3 | `e231c47` | key revoke no rollback | high | `keys/_variants/data.ts` |
| 4 | `972c5d4` | demo plays premade + deletes wrong character | high, high | `variants/HeroMicDemo.tsx` |

## What was fixed

One mental model across the wave: **check the HTTP response before telling the user their consent / clone / revoke action succeeded.** `fetch` resolves on any status, so a discarded response plus an optimistic UI transition is success theater.

1. **Voice revoke lies about consent (CRITICAL)** — `MyVoices.revoke` discarded the DELETE response and always marked the vault "revoked", so a failed engine delete still told the user their voice was deleted and consent withdrawn while it stayed synthesizable. Now checks `r.ok` (404 = already gone = success), only marks revoked on real success, and surfaces an error banner + reconciles on failure.
2. **Consent-provenance write silently lost** — `recordVoiceOwnership` swallowed per-doc failures; it now uses `Promise.allSettled` and returns a `{saved, failed}` summary (still never throws) so a lost consent receipt can be surfaced.
3. **markRevoked out of sync** — returned void and swallowed the ledger write; now returns a boolean the caller checks.
4. **Ownership record dropped on late auth** — the "record once on complete" effect latched its one-shot *before* the guarded work, so a `complete` render that beat Firebase's `onAuthStateChanged` consumed the shot and never wrote the ownership mapping. Latch moved inside the success branch; a failed receipt now shows an amber warning on the complete screen.
5. **chooseSpeaker swallowed errors** — fired the POST with no `r.ok` check and advanced optimistically; now verifies and surfaces the error.
6. **Double-submit on scan/speaker/commit** — no in-flight guard, so a double-click could spawn two ingest jobs or two clone commits. Added a `submitting` ref guarding all three.
7. **Optimistic key revoke leaves a live key hidden** — removed the row then relied on `refresh()` to restore on failure, which itself throws when the backend is down. Now snapshots the list and restores + errors on any non-ok/throw (404 = success).
8. **Demo plays a premade voice claiming it's cloned** — a voiceless 200 clone fell through to `/api/tts`, which defaults to the stock "alba" voice. Now throws if the clone returns no `voice_id`.
9. **Demo deletes the wrong character** — cleanup used a client-reconstructed slug that can diverge from the backend's slug rules, leaving the cloned biometric demo voice behind. Now deletes the `character_id` the clone response returned.

## Verification

| Gate | Before | After |
|---|---|---|
| web `tsc --noEmit` | 0 errors | 0 errors |
| web `next build` | PASS | PASS |
| lint | clean | clean |

(No web unit-test runner in this project; changes verified by tsc + build + code review. UI paths — the revoke error banner, the vault-warning on complete, the key-revoke rollback — have no automated coverage and would benefit from an eyeball / e2e pass.)

## Patterns established (catalogue items 5–8)

5. **Verify the response before claiming the write succeeded.** `fetch` resolves on any HTTP status; a discarded response + optimistic UI = success theater. Check `r.ok`, treat 404-on-delete as already-gone, and only then tell the user it happened. (MyVoices, keys, chooseSpeaker)
6. **Latch a one-shot inside its success branch, not before it.** An effect that sets `done.current = true` before its guarded work consumes the shot on a no-op run (dependency not ready yet) and never completes when the dependency arrives. (voices/new ownership)
7. **Optimistic mutations need snapshot+rollback, not a re-fetch.** Restoring via `refresh()` fails exactly when needed (backend down). Snapshot before the optimistic change; restore on every error path. (keys revoke)
8. **Delete by the id the server returned, never a client re-derivation.** Reconstructing a server identifier (slug) client-side diverges silently; use the id from the create/clone response. (hero demo)

## Deferred / not in this wave

- The two consent-integrity **service-side** findings — mid-batch ingest orphaning consent-stamped voices (`service/ingest.py`, high) and swallowed streaming errors (`service/app.py`, high) — belong to the data-lifecycle/observability theme and are folded into a later service-focused wave (they can't get a full pytest run on this Windows box anyway).
- **web-lib-utils #2** (vault stores a divergent consent statement, not the canonical `CONSENT_STATEMENT`) is a consent-*wording* consistency issue — grouped with the refactor/dedup wave.
- `/api/tts` still defaults a missing `voiceId` to "alba"; the hero-demo guard fixes the demo's exposure to it, but hardening the route to 400 on empty voiceId is left out to avoid a playground regression without verification (small follow-up).

## What remains (per INDEX)

Waves 3–9 open: races/TOCTOU (service), resource leaks/deadlock, persistence/atomic-writes, money-truth, web UX contract, test integrity, dead-code/duplication.
