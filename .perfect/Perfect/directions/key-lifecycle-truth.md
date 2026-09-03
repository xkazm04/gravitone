---
slug: key-lifecycle-truth
type: perfect/direction
context: "[[Speech Synthesis API]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 233314c
---
## What & why
`keys.py` advertises "issue / rotate / revoke" and carries a `revoked` field that is modelled, persisted, and checked in two places — but nothing ever sets it True. The only way to stop a leaked key is a hard `DELETE`, which destroys its audit identity. Meanwhile every read-modify-write of the credential store is guarded by a `threading.Lock` alone, while the service deliberately ships as N separate replica processes — a lost-update race on `api_keys.json`. And validation re-reads and linearly scans the whole file on every authenticated request.

## Evidence
- `service/keys.py:54` `revoked` modelled; `:132` persisted `False`; `:147` checked on rotate; `:181` checked on validate — no writer anywhere; `:156-165` `DELETE` hard-deletes.
- `service/keys.py:38` `_STORE_LOCK = threading.Lock()` — in-process only; `service/replicas.py` runs N processes with `SO_REUSEPORT`.
- `service/atomicio.py::file_lock` exists with stale-lock reclamation but has exactly ONE caller: `service/voices.py:237` (`mutate_meta`) — the proven pattern is already in the repo, unused here.
- `service/keys.py:176-177` — full JSON load + linear scan per authenticated request.
- CLAUDE.md § Cross-process exclusion names this exact anti-shape ("a bare `threading.Lock` guarding a file that another process also writes").

## Acceptance criteria
- `POST /v1/keys/{kid}/revoke` (admin scope) sets `revoked=True`; a revoked key 401s on use, stays listed and auditable, and cannot be rotated back into service (the existing 409 path).
- Every mutation of `api_keys.json` takes `atomicio.file_lock` ALONGSIDE the thread lock — the `voices.mutate_meta` pattern, not a new mechanism.
- Validation reads through an in-memory index invalidated by file mtime/size, so the common path is not a per-request disk read; an external write (another replica) is picked up.
- The `last_used` 60s debounce (`keys.py:184-187`) keeps working and does not resurrect a deleted/revoked key.
- Tests: revoke → 401 while still listed; two processes writing concurrently lose no key; index staleness after an out-of-band write; debounce interaction with revoke.

## Risks / non-goals
- Do not let the index become a second source of truth — the file stays authoritative, the index is a cache with a cheap validity check.
- Non-goal: per-key rate limits, TTL/expiry, per-key usage accounting (billing-flavored — rejected in round 1 as `per-key-usage-metering`).
- Non-goal: changing the open-by-default posture when `TTS_API_KEY` is empty (separate decision, note it in the report if it looks dangerous).

## Build record
Builder S2 (branch commit 63e3a38 → cherry-picked to main as 233314c). `POST /v1/keys/{kid}/revoke` added to the ALREADY-mounted keys router (no app.py edit — sibling builder owned that file): revoked keys 401 on the next request, stay in `GET /v1/keys` with scopes/created/last_used intact, 409 on rotate, idempotent, 404 unknown. Every read-modify-write now goes through one `_mutate(fn)` holding `_STORE_LOCK` AND `atomicio.file_lock(_lock_path())` — copied from `voices.mutate_meta`, no new mechanism; lock path derived from KEYS_PATH at CALL time (tests repoint it); a `file_lock` TimeoutError routes through `errors.sanitized_500`. `validate_key` now reads an in-memory index keyed on `(store path, mtime_ns, size, local write generation)` — common path is one `stat` + in-memory scan, deliberately linear with NO early break to preserve the `compare_digest` timing property; another replica's write is picked up on the next call. Debounced `last_used` persist re-reads under both locks and refuses to write if the key was deleted or revoked meanwhile. `_STORE_LOCK` promoted to RLock. Windows-specific fix: index rebuild also takes `_STORE_LOCK`, because `os.replace` onto a path another thread holds open raises PermissionError there.

**Director review**: read the full diff. Verified `errors.sanitized_500` RETURNS an HTTPException (so `raise sanitized_500(...)` is correct usage), verified the `_mutate` skip-save-on-raise path leaves the file intact for the 404/409 cases, verified revoke deliberately does NOT clear `_LAST_USED` (audit evidence survives) and that the debounce re-check makes an in-flight bump unable to un-revoke. Builder's own falsification test is the standout: it temporarily replaced `file_lock` with `nullcontext` and got **12 of 36 keys surviving plus PermissionError crashes**, vs 36/36 clean with the lock — the cross-process test is proven meaningful, not decorative. Gates on main: `compileall` clean, `pytest service/tests -q` → 244 passed, 14 subtests. MERGED.
