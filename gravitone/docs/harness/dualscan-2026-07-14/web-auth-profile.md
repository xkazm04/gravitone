# Dual-lens scan — web-auth-profile
> Files: 5 | Findings: 5 (crit 1 / high 3 / med 1 / low 0)
> Lenses: bug-hunter + code-refactor

## 1. Voice revoke marks vault "revoked" even when the engine delete failed
- **Severity**: critical
- **Lens**: bug-hunter
- **Category**: silent-failure / consent-integrity
- **File**: `web/app/profile/MyVoices.tsx:33`
- **Scenario**: A user clicks "revoke" (confirm text promises "The voice embedding is deleted"). The `DELETE /api/voices/{id}` call returns 404/500 or the backend is down, but `fetch` resolves without throwing. Code never checks `r.ok`, so it proceeds to `markRevoked(uid, voice_id)` and `refresh()`.
- **Root cause**: `await fetch(...)` result is discarded — the engine-side deletion and the Firestore provenance update are treated as one atomic act, but only the second is verified. `fetch` only rejects on network layer failure, not on HTTP error status.
- **Impact**: The vault shows the voice as "revoked" and tells the user consent was withdrawn and the embedding deleted, while the cloneable voice embedding still lives on the synthesis engine and remains usable. For a consent-centric voice-cloning product this is a data-integrity/consent violation and success theater — the worst-case being a subject who asked for deletion whose voice is still synthesizable.
- **Fix sketch**: Check `if (!res.ok) throw`/surface an error and do NOT call `markRevoked` unless the DELETE succeeded (or the resource is confirmed already-gone via 404-as-success). Show a failure state in `finally` instead of silently refreshing to a "revoked" row.

## 2. Profile save() has no error handling — a failed Firestore write hangs the button forever
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: silent-failure / stuck-state
- **File**: `web/app/profile/page.tsx:41`
- **Scenario**: User edits display name and clicks Save while offline or when a Firestore security rule/quota rejects the write. `updateProfile` → `updateDoc` rejects; the `await` in `save()` throws.
- **Root cause**: `save()` runs `setSaving(true)` then `await updateProfile(...)` with no `try/catch/finally`. On rejection the subsequent `setSaving(false); setSaved(true)` lines never execute, and the rejection becomes an unhandled promise rejection.
- **Impact**: The Save button is left permanently disabled showing "Saving…", no error is shown to the user, and the edit is silently lost. User believes the app froze. (Contrast: `mint()` is safe only because `mintDefaultKey` never throws.)
- **Fix sketch**: Wrap the body in `try { … setSaved(true) } catch { setError(...) } finally { setSaving(false) }` and surface an error message next to the button.

## 3. First-sign-in auth callback can mint duplicate keys and overwrite the user doc
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: race-condition / TOCTOU
- **File**: `web/lib/useAuth.tsx:66`
- **Scenario**: `onAuthStateChanged` fires more than once in quick succession for the same new user (e.g. redirect completion + immediate token/state emission) before the first `setDoc` commits. Both invocations read `getDoc`, both see `snap.exists() === false`, so both take the not-exists branch.
- **Root cause**: The exists-check and the create-write are a non-atomic read-modify-write with no guard/dedupe flag against re-entrant callback runs. The not-exists branch also uses `setDoc` without `{ merge: true }`, and unconditionally calls `mintDefaultKey`.
- **Impact**: Two API keys get minted for one account (only the last `keyId`/`keyPrefix` is retained in Firestore and only the last secret in localStorage — the first becomes an orphaned live credential), and a concurrent `setDoc` can clobber fields like `plan`/`createdAt`. Also double `window.location.assign("/profile")` navigation churn.
- **Fix sketch**: Use `setDoc(ref, {…}, { merge: true })` for the create, gate first-run provisioning behind an in-memory `mintedRef`/processing flag keyed by uid, and prefer a transaction (or `createdAt`-absent check inside a transaction) to make create-once atomic.

## 4. Avatar + plan-badge markup duplicated across profile page and UserMenu
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `web/components/ui/UserMenu.tsx:53`
- **Scenario**: The photoURL-or-initial avatar block and the "{plan ?? 'free'} plan" pill are hand-rolled in two places: `UserMenu.tsx:53-58`/`72-74` and `web/app/profile/page.tsx:66-73`/`77-79`. The initial derivation `(profile?.displayName ?? user.email ?? "?").slice(0,1).toUpperCase()` is repeated verbatim, including the `eslint-disable no-img-element` + `referrerPolicy="no-referrer"` handling.
- **Root cause**: No shared presentational component for the user identity chip; each surface re-implements the same fallback logic and styling.
- **Impact**: Style/behavior drift risk (e.g. one place fixes the referrer policy or initial fallback and the other doesn't) and duplicated maintenance for a security-relevant `<img>` config.
- **Fix sketch**: Extract `<Avatar user profile size=… />` and `<PlanBadge plan={profile?.plan} />` into `components/ui/` and consume from both `UserMenu` and the profile page.

## 5. API secret persists in localStorage after sign-out (shared-machine leak)
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: secret-leakage / trust-boundary
- **File**: `web/lib/useAuth.tsx:113`
- **Scenario**: User A signs in on a shared/public browser, a tts-scoped key is minted and its plaintext secret stored at `gravitone.apiKey.{uid}` (mintKey.ts:38). User A clicks "Sign out" (`fbSignOut`). The next person on that machine opens devtools (or an app path that reads it) and recovers the live secret.
- **Root cause**: `signOut` only calls `fbSignOut(auth)`; it never clears the per-uid `localStorage` key. `mintKey` stores the copy-once secret in plaintext with no expiry and no logout hook.
- **Impact**: A functional TTS API credential outlives the authenticated session on the device — a real credential-leak on shared/kiosk browsers, and the secret lingers indefinitely even for the owner.
- **Fix sketch**: In `signOut`, before/after `fbSignOut`, `localStorage.removeItem(slot(uid))` (expose a `clearStoredKey(uid)` from mintKey). Optionally scope the secret to `sessionStorage` or gate re-copy behind a fresh backend fetch rather than long-lived plaintext.
