# Dual-lens scan — web-api-keys
> Files: 8 | Findings: 5 (crit 0 / high 2 / med 2 / low 1)
> Lenses: bug-hunter + code-refactor

## 1. Optimistic revoke leaves a live key hidden with no rollback
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: silent-failure / success-theater
- **File**: `web/app/keys/_variants/data.ts:74`
- **Scenario**: User clicks "revoke". `deleteKey` immediately removes the row from state (line 75), then `await fetch(... DELETE ...)`. If the fetch *throws* (offline, connection reset, Next dev server hiccup), execution stops before line 77 and the rejection is unhandled — the `onClick={() => deleteKey(k.id)}` caller (KeysLedger.tsx:98) does not await or catch it. Even in the handled `!r.ok` path, the backend-unreachable case returns 503, `refresh()` then also 503s and throws, so `setKeys` never re-runs and the deleted row is never restored.
- **Root cause**: Optimistic delete assumes the request always resolves and that `refresh()` will faithfully restore state on failure; neither holds. The optimistic mutation has no `try/catch` rollback.
- **Impact**: For an API-key *revoke*, the UI shows the key as gone (success theater) while it remains fully valid on the backend. A user revoking a leaked key believes it is dead when it still authenticates — a real consent/security gap.
- **Fix sketch**: Wrap in `try { await fetch } catch { await refresh() }`, and in the `!r.ok` branch restore optimistically-removed state even when `refresh()` itself fails (snapshot the removed key and re-insert on any error path). Surface an error toast on failure.

## 2. Rotate/revoke row handlers swallow failures and allow double-submit
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: error-handling / double-submission
- **File**: `web/app/keys/_variants/KeysLedger.tsx:97`
- **Scenario**: `onClick={async () => setReveal(await rotateKey(k.id))}`. `rotateKey` throws on non-OK (data.ts:69), producing an unhandled promise rejection with zero UI feedback — unlike `create()` which has `busy`/`try/catch`/`setErr`. Neither rotate nor revoke has a per-row busy guard, so a double-click fires two rotations (or two revokes) back-to-back.
- **Root cause**: The create flow was hardened (busy flag + error state) but the inline row handlers were left as bare `await` expressions with no state machine.
- **Impact**: A failed rotate looks like a no-op (user re-clicks, confused). A double-clicked rotate mints and immediately invalidates an intermediate secret, and the revealed secret can be the already-superseded one — a confusing, hard-to-reproduce key-mismatch.
- **Fix sketch**: Track a per-row pending id (`busyId`), disable both buttons while pending, and wrap the rotate call in `try/catch` that routes into the existing `err`/`setErr` banner.

## 3. Migration compatibility check never uses the minted key — false-positive pass
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: success-theater / correctness
- **File**: `web/app/keys/_variants/MigrationKit.tsx:44`
- **Scenario**: The panel claims to "replay a real ElevenLabs-shaped request" using the freshly minted secret, but `runCheck` POSTs to `/api/tts` with only `Content-Type` — no `xi-api-key` header, and the `apiKey` prop is used solely for the copyable snippet. The check therefore exercises the studio proxy's own auth, not the user's new key. On success it renders "✓ ElevenLabs-shaped request served".
- **Root cause**: The check reuses the internal studio TTS proxy (which authenticates itself) instead of hitting the public keyed endpoint with `Authorization`/`xi-api-key: apiKey`.
- **Impact**: A user whose key is wrong-scoped, mistyped-on-copy, or otherwise broken still sees a green "compatibility passed", giving false confidence that their migration will work. The one feature meant to *prove* the key validates nothing about the key.
- **Fix sketch**: Send the real credential (`headers: { "xi-api-key": apiKey }`) against the keyed synthesis route so the check actually verifies the presented key and its `tts` scope; otherwise re-label it as a "server reachable" probe, not a compatibility pass.

## 4. Raw API secret persisted in localStorage — XSS-exfiltratable long-lived credential
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: secret-leakage
- **File**: `web/lib/mintKey.ts:38`
- **Scenario**: `mintDefaultKey` writes the full plaintext secret to `localStorage["gravitone.apiKey.<uid>"]` so UserMenu/profile can "copy my key" later. Any XSS (a bad dependency, a reflected snippet, a compromised third-party script) can read `localStorage` and exfiltrate every stored key, and the value persists indefinitely on shared/kiosk browsers.
- **Root cause**: The product's copy-once model is undermined by persisting the secret client-side; localStorage is readable by any same-origin script and is not cleared on sign-out here.
- **Impact**: A single XSS turns into silent theft of a bearer-equivalent API secret that grants synthesis/clone/performance access and bills the account — the highest-value token in the app stored in the least protected place.
- **Fix sketch**: Do not persist the secret. Keep it in memory for the reveal session only; if later "copy" is required, re-mint (rotate) on demand rather than caching. At minimum clear the slot on sign-out and scope/expire it, but memory-only is the correct fix for a copy-once secret.

## 5. `MintedKey` duplicates the `ApiKeyWithSecret` shape across files
- **Severity**: low
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `web/lib/mintKey.ts:7`
- **Scenario**: `mintKey.ts` declares `MintedKey = { id; name; prefix; scopes; secret }`, which is exactly `ApiKeyWithSecret` (`web/app/keys/_variants/data.ts:14`) minus `created/last_used/revoked`. Both describe "a key returned with its one-time secret" and are populated from the identical `/api/keys` POST response, so they drift independently.
- **Root cause**: Two consumers of the same API response each hand-rolled a local type instead of importing a shared one.
- **Impact**: If the mint response gains/renames a field, one type updates and the other silently rots; the redundant declaration invites subtle field-shape mismatches.
- **Fix sketch**: Define `export type MintedKey = Pick<ApiKeyWithSecret, "id" | "name" | "prefix" | "scopes" | "secret">` (import from `_variants/data`), or promote a single canonical minted-key type into a shared module both files import.
