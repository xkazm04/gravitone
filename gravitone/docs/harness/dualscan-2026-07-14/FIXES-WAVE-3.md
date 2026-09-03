# Dual-scan Fix Wave 3 — Races / TOCTOU

> 6 commits, 6 findings closed (5 high, 1 medium).
> Gates: web `tsc` 0 / `next build` PASS; Python `py_compile` OK, `test_replicas` 17/17, `test_keys` 4/4, atomic-pick proven by smoke test.

## Commits

| # | Commit | Finding | Severity | File |
|---|---|---|---|---|
| 1 | `898cdec` | create_voice TOCTOU on emotion slot | high | `service/voices.py` |
| 2 | `78c6d1c` | review pick lost-update | high | `service/takes.py` |
| 3 | `0578bd5` | submit/stop admission race | medium | `service/engine.py` |
| 4 | `652023f` | dead replica's socket black-holes traffic | high | `service/replicas.py` |
| 5 | `9f38d2e` | first-sign-in duplicate keys | high | `web/lib/useAuth.tsx` |
| 6 | `fbef764` | ensureShared double-publish | high | `web/app/playground/_variants/PlaygroundConsole.tsx` |

## What was fixed

1. **create_voice re-checks under the lock** — the duplicate-emotion guard ran only before the multi-second clone subprocess, so two concurrent clones of the same character+emotion both passed and both committed (one embedding orphaned). `_commit` now re-verifies the slot under `_META_LOCK` (mirroring `import_pack`) and deletes the just-cloned embedding before raising 409.
2. **Review pick is atomic first-wins** — `pick_take` did a read-check-write, so two picks both passed the "already decided" check and the second clobbered the first. Now gated by an `O_CREAT|O_EXCL` `<review_id>.pick` sentinel: exactly one writer wins across threads *and* replica processes; the rest get 409. Sentinel evicted with its review, rolled back on write failure. **Proven** by smoke test (first persists, second → 409).
3. **submit/stop admission race** — `submit` checked `_stopping` then `put()` as separate steps, so a job admitted just before shutdown could land after the final drain sweep — Future never resolved, permit leaked. Added `_enqueue_lock`: `stop()` flips `_stopping` under it, `submit()` re-checks under it while enqueuing and releases+503s if shutdown won.
4. **Dead replica's socket black-holes traffic** — the parent held its own fd to each child's `SO_REUSEPORT` socket, so a crashed child left the socket alive-but-unserved in the reuseport group and the kernel routed ~1/N of connections into a queue nothing drained (hang → RST) for the whole backoff window. Parent now drops its socket reference right after spawn (the child owns its inherited copy), so the socket dies with the child.
5. **First-sign-in duplicate keys** — a re-entrant `onAuthStateChanged` for a new user could take the create branch twice, minting two keys (one orphaned-but-live) and clobbering the doc. Added an in-memory `provisioning` uid guard (synchronous check+add) + `setDoc(merge: true)`.
6. **ensureShared double-publish** — `share()` guarded against a re-entrant upload but `ensureShared()` didn't, so a "pending" share fell through to a second `uploadTake` → two `/t/{id}` pages for one take + a desynced review link. Both paths now use `uploadOnce()`, coalescing on a `Map<takeId, Promise>` of in-flight uploads.

## Verification

| Gate | Result |
|---|---|
| web `tsc --noEmit` | 0 errors |
| web `next build` | PASS |
| `service.tests.test_replicas` | 17/17 |
| `service.tests.test_keys` | 4/4 |
| atomic-pick smoke | first-pick-wins ✓ (2nd → 409, sentinel created) |
| `py_compile` (voices/takes/engine/replicas) | OK |

**Verification gaps (Windows box):** `voices.py` and `engine.py` can't be imported without torch, so their fixes are gated by `py_compile` + code review + (for voices) the fact that the re-check is a direct mirror of the already-tested `import_pack` pattern. The **replicas.py** fix only affects the Linux `SO_REUSEPORT` path (a no-op on this box) and needs a **multi-replica runtime test on a real Arm/Linux box** to confirm the black-hole is gone — that cluster test is already a tracked follow-up.

## Patterns established (catalogue items 9–13)

9. **Re-check invariants inside the lock, not just before the slow op.** A pre-check before a long subprocess/await is a fast-fail; the real guard must re-verify inside the critical section — and clean up any artifact created in the window. (create_voice)
10. **`O_CREAT|O_EXCL` is the cross-process first-writer-wins primitive.** A read-check-write of a file is a lost-update race across threads *and* processes; an exclusive-create sentinel makes exactly one writer win. (review pick)
11. **Order a shutdown flag against producers with a shared lock.** Setting a "stopping" bool and draining isn't atomic against a concurrent enqueue; guard both the flag-flip and the enqueue with one lock. (engine)
12. **Own a shared resource only as long as it's served.** Holding a `SO_REUSEPORT` listening fd open past the process that serves it turns a dead endpoint into a traffic black-hole; release the parent's copy once the child owns it. (replicas)
13. **Coalesce idempotent async actions across entry points.** Two triggers for the same upload/mutation must await one in-flight promise, or a race mints duplicates. (playground share)

## Deferred / not in this wave

- The service-side data-integrity findings from the consent theme (ingest mid-batch orphans, streaming errors swallowed) and the **atomic-write persistence** findings (key-store, demand.json — `service/keys.py`, `service/demand.py`) are the natural next service wave (persistence/atomic-writes). demand.json's fix is the same `os.replace` atomic-write pattern.

## What remains (per INDEX)

Waves 4–9 open: resource leaks/deadlock (ingest stderr pipe, ffmpeg/HTTP timeouts, object-URL leaks), persistence/atomic-writes, money-truth (fully web-verifiable), web UX contract (fully web-verifiable), test integrity, dead-code/duplication.
