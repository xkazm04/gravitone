# Dual-scan Fix Wave 1 — Security / auth

> 6 commits, 8 findings closed (1 critical, 5 high, 2 medium).
> Gates: web `tsc` 0 errors, `next build` PASS; Python `py_compile` OK, `test_keys` 4/4, certify fail-closed proven by smoke test. Baseline preserved.

## Commits

| # | Commit | Findings closed | Severity | Files |
|---|---|---|---|---|
| 1 | `37db48a` | certify verify fails open | **critical** | `service/certify.py` |
| 2 | `c9e583b` | unsigned-pack bypass + zip bomb | high, high | `service/packs.py` |
| 3 | `f0934d6` | non-constant-time key compare | medium | `service/auth.py`, `service/keys.py` |
| 4 | `90c7d49` | AppFrame fail-open + secret-after-signout | high, high | `AppFrame.tsx`, `useAuth.tsx`, `mintKey.ts` |
| 5 | `0ab55cc` | unbounded body on synthesis relays | high, medium | `lib/backend.ts`, `api/{speak,performance,tts}/route.ts` |

## What was fixed

1. **Certificate verification fails open (CRITICAL)** — `verify_certificate` only enforced the HMAC when a signature was *present*, so a forged cert with `verdict:"certified"` and the signature field stripped was accepted even by a verifier holding the secret — an enterprise-tier entitlement bypass. A configured secret now makes the signature **required**; unsigned certs fail closed. Proven: `secret set, unsigned → rejected`, `secret set, signed → accepted`, `no secret, unsigned → accepted` (open-mode preserved).
2. **Unsigned-pack signature-stripping bypass** — `import_pack` gated authenticity on "signature present" (`if PACK_SECRET and sig`), trivially defeated by omitting the field. A configured `TTS_PACK_SECRET` now rejects any unsigned pack.
3. **Zip bomb / OOM in `import_pack`** — each voice member was fully `z.read()`-decompressed before its size was checked, so a tiny crafted deflate blob expanding to GBs could OOM-kill the service. Now the ZIP directory's declared `file_size` is checked before decompression, with a per-pack total-size budget; the post-read `len()` check stays as defense in depth.
4. **Non-constant-time key comparison** — root-key `==` and managed-key hash `==` short-circuit, leaking the secret byte-by-byte via timing. Both now use `secrets.compare_digest`. `test_keys` stays green.
5. **AppFrame auth gate fails open** — the gate keyed on `ready` (Firebase config *presence*), so a misconfigured deploy collapsed every gate and rendered the studio to all visitors. Added an explicit `authResolved` signal to `useAuth` (true once `onAuthStateChanged` fires, or immediately when config is absent); AppFrame now gates on it and **fails closed** (bounces to landing) on misconfig. Nav renders only for signed-in users.
6. **API secret persists after sign-out** — `signOut` left the copy-once plaintext secret in `localStorage`, recoverable by the next user of a shared browser. `signOut` now clears it via `clearStoredKey(uid)` (captured before `fbSignOut`).
7. **Unbounded body on synthesis relays** — `/api/speak`, `/api/performance`, `/api/tts` forward client text to the backend with the root key and hold a synth slot up to ~3 min, unauthenticated. Added `readCappedText()` — 413 on oversize (Content-Length short-circuit + byte-accurate recheck), 128 KB for scripts / 64 KB for a single utterance.

## Verification

| Gate | Before | After |
|---|---|---|
| web `tsc --noEmit` | 0 errors | 0 errors |
| web `next build` | PASS | PASS |
| Python `py_compile` (edited files) | — | OK |
| `service.tests.test_keys` | 4/4 | 4/4 |
| certify fail-closed smoke | forged accepted | forged **rejected** |

## Patterns established (catalogue items 1–4)

1. **Opt-in-security → required-security.** A check gated on "the credential/signature is *present*" (`if secret and sig`) is a downgrade path: strip the field to bypass. When a secret is configured, make the proof **required** and fail closed. (certify, packs)
2. **Decompress-after-check, never check-after-decompress.** Size-limit against the archive's *declared* uncompressed size before `read()`, plus a running total budget — a `len(data)` check after decompression is already too late for a zip bomb. (packs)
3. **Auth "resolved" ≠ config "present".** Gate UI on a signal that flips only once the auth state is actually known (or definitively absent), never on config-presence — otherwise a misconfig silently opens the gate. (AppFrame/useAuth)
4. **Cap the unauthenticated compute surface.** Any route that spends real CPU/holds a slot for an anonymous caller needs an early body/size cap (and, when the trust model lands, auth + rate limit). (synthesis relays)

## Deferred (need a product / architecture decision — NOT closed)

- **web-api-keys #4** — fully de-persist the API secret (memory-only) to close the XSS-exfil vector. Removes the "copy my key later" feature the profile/UserMenu depend on → persist-for-copy vs. copy-once-then-rotate is a product call. Sign-out clearing (above) is the interim mitigation.
- **web-character-api #1 / web-takes-reviews-share #5** — the privileged-write proxies (`/api/characters`, `/api/voices`, `/api/takes`) attach the root key with no caller auth. Full fix needs the web→service trust model (per-user Firebase session gate vs. same-origin/CSRF), already tracked in `followups-2026-07-10.md`. User chose to harden the DoS surface now and defer this.

## What remains (per INDEX)

Waves 2–9 open: consent/data-integrity silent failures (holds the 2nd critical — MyVoices revoke), races/TOCTOU, resource leaks/deadlock, persistence/atomic-writes, money-truth, web UX contract, test integrity, dead-code/duplication.
