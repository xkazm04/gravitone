# Dual-lens scan — svc-takes-certify
> Files: 2 | Findings: 5 (crit 1 / high 1 / med 3 / low 0)
> Lenses: bug-hunter + code-refactor

## 1. Certificate verification fails open — unsigned forged cert accepted even when verifier holds the secret
- **Severity**: critical
- **Lens**: bug-hunter
- **Category**: trust-boundary / auth-bypass
- **File**: `service/certify.py:140`
- **Scenario**: An attacker builds any cert dict (`verdict: "certified"`, arbitrary hardware/capacity), computes `sha256` over its canonical form (trivial — the hash is unkeyed and self-referential), and OMITS the `signature` field. `verify_certificate(cert, secret)` runs: the sha256 self-check passes (attacker just computed it), then `if secret and sig:` is False because `sig` is `None`, so it falls through to `return True`.
- **Root cause**: The sha256 is an unkeyed checksum over attacker-controlled data — it provides zero integrity against a malicious party. The only real control is the HMAC, but it is only enforced when the cert *happens to include* a signature. A cert with the signature stripped is treated as trusted. Security check is opt-in by the data being verified.
- **Impact**: The supported/enterprise tier keys off a "certified" verdict. Anyone can mint a passing certificate for any box and unlock the paid/enterprise tier and pollute `SUPPORTED_HARDWARE.md` — a paywall/entitlement bypass.
- **Fix sketch**: When `secret` (or `CERT_SECRET`) is set, REQUIRE a present, valid HMAC signature — `return bool(sig) and hmac.compare_digest(want, str(sig.get("value","")))`. Never `return True` on a missing signature when a secret is configured. Treat the sha256 as a non-security integrity hint only.

## 2. Non-atomic "first pick wins" — concurrent picks silently overwrite the recorded approval
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: race-condition (lost update / TOCTOU)
- **File**: `service/takes.py:210`
- **Scenario**: Two reviewers open the no-login approval link and click near-simultaneously. Both requests `_load_review()` and read `review.get("pick")` as falsy (line 210), both pass the "already decided" guard, both build a pick and `write_text()` (line 227). The second write clobbers the first.
- **Root cause**: The read-check-write of the decision is not atomic; there is no lock or atomic create-if-absent on the review file. The docstring's contract — "First pick wins — a decided review is final" — is only enforced within a single request, not across concurrent ones.
- **Impact**: The recorded winner can differ from the pick the first client saw confirmed (they got a 200, then it was overwritten). For an approval/consent loop that agencies bill against, the persisted decision is untrustworthy under concurrency, and `preferred()` aggregates the wrong character.
- **Fix sketch**: Make the decision atomic — write to a temp file and `os.rename` only if the pick file/marker does not yet exist (atomic `open(..., "x")` for a `.pick` sentinel), or serialize per-review-id with a lock; re-read and re-check under the lock before committing.

## 3. Malformed `meta` crashes create_take with a 500 instead of a 400
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: silent-failure / unvalidated-input
- **File**: `service/takes.py:83`
- **Scenario**: A client POSTs valid JSON whose `segments` list contains non-dict elements, e.g. `{"text":"x","segments":["oops"]}`. Validation at line 64 only checks `isinstance(segments, list)` and length, so the loop reaches `s.get("text", ...)` (line 83) and raises `AttributeError` → unhandled → HTTP 500. The same happens for non-numeric numeric fields: `float(m.get("seconds"))` (line 79) or `float(s.get("seconds"))` (line 87) raise `ValueError` on `"seconds":"fast"`.
- **Root cause**: Field-level coercion (`float(...)`, `s.get(...)`) runs on untrusted input at the HTTP boundary without per-element type guards; only the container shape is validated.
- **Impact**: Adversarial or buggy clients get an opaque 500 (success-theater inverse: a client error surfaces as a server error), the error is not attributable, and it clutters logs / alerting for what should be a clean 400.
- **Fix sketch**: Guard each segment with `isinstance(s, dict)` (skip/reject otherwise), and wrap the numeric coercions in a helper that defaults on `ValueError`/`TypeError` (e.g. `_num(x, default)`), raising `HTTPException(400)` on structural violations rather than letting exceptions escape.

## 4. `clean_at_cap` check can grade a different concurrency level than the reported cap
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: edge-case / correctness
- **File**: `service/certify.py:73`
- **Scenario**: A loadtest result reports `recommended_cap` (say 6) that is not present among the measured `levels` (concurrencies e.g. 1, 2, 4, 8). Line 72 sets `cap = 6`, but line 73 `next(... , rows[-1])` finds no matching row and falls back to `rows[-1]` (concurrency 8). `cap_errors` (line 76) is then read from level 8 while the certificate advertises `recommended_cap = 6`.
- **Root cause**: `cap` and `at_cap` are derived independently with mismatched fallbacks; there is no invariant that the cap has a corresponding measured row.
- **Impact**: The "zero errors at cap" verdict is computed against a level that was never the cap — a box can be certified (or wrongly failed) on error figures from the wrong concurrency, undermining the exact guarantee the certificate exists to make.
- **Fix sketch**: Resolve `cap` from the measured rows: if `recommended_cap` has no matching row, either fail with a clear "cap N not in measured levels" error, or snap `at_cap` to the nearest measured level and record that substitution in the certificate.

## 5. Duplicated bounded-store eviction logic (takes vs reviews)
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `service/takes.py:44`
- **Scenario**: `_evict_oldest()` (lines 44–48) and the inline block in `create_review()` (lines 161–163) implement the same eviction: `sorted(dir.glob("*.json"), key=st_mtime)`, slice `[: max(0, len(metas) - CAP + 1)]`, `unlink`. Two copies with a subtle divergence — the takes path unlinks the paired `.wav`, the reviews path unlinks only `.json`.
- **Root cause**: The bounded-store trim is a shared concept expressed twice; the caps and the sidecar-file handling differ, so the copies drift.
- **Impact**: Any fix (e.g. the off-by-one in `- CAP + 1`, or making eviction atomic/concurrency-safe per finding-2 style) must be made in two places and is easy to miss; the `.wav` sidecar asymmetry is exactly the kind of divergence duplication breeds.
- **Fix sketch**: Extract `_evict(dir: Path, cap: int, sidecars: tuple[str, ...] = ())` and call it from both `create_take` (with `(".wav",)`) and `create_review` (with `()`), centralizing the sort/slice/unlink and the sidecar cleanup.
