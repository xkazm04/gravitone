# Dual-scan Fix Wave 8 — Test integrity

> 7 commits: 8 findings closed (7 medium, 1 low) **+ 1 self-inflicted regression fixed**.
> Suite: **163 tests across all 17 modules, 0 failures** (was 161 with `test_compat` red).
>
> Theme: **the suite must be able to fail, and must not flake.** A test that passes while asserting nothing is worse than no test — it buys false confidence in exactly the guarantees you'd most want checked.

## ⚠ First: a regression this wave caught (mine)

`test_compat` had been **red since Wave 4**. My `timeout=60` addition to `wav_bytes_to_mp3` (`e731af7`) broke two stubs that declared a rigid `fake_run(cmd, input, stdout, stderr)` and raised `TypeError` on the new kwarg. **Wave 4 only re-ran `test_ingest_*` and `test_replicas`, so I reported that wave's gates green on a subset while a module was failing.** Waves 5–7 never re-ran it either.

Fixed in `9dcb0c6`: the stubs take `**kw` (mirroring `subprocess.run`'s tolerance, so a source-side kwarg can't manufacture a fake failure) **and** the bitrate test now asserts a timeout is passed — locking in the Wave 4 fix instead of merely tolerating it.

**Process lesson (recorded in `harness-learnings.md`):** run the full suite before calling a wave green. Also corrected there: the whole suite *does* run on Windows (163 tests, no torch — `fake_engine` installs the shims), contradicting my earlier "not pytest-able" note, which was over-broad.

## Commits

| # | Commit | Finding | Severity | File(s) |
|---|---|---|---|---|
| 0 | `9dcb0c6` | **regression**: test_compat red since Wave 4 | — | `tests/test_compat.py` |
| 1 | `929df83` | abandon test races the permit release; private `_admit._value` | medium, low | `engine.py`, `test_abandon.py`, `test_drain.py` |
| 2 | `7c0a1f6` | FakeEngine capacity ≠ backpressure; thread-pool leak | medium ×2 | `fake_engine.py`, `test_compat.py`, `test_parallel.py` |
| 3 | `cab7dad` | key-store concurrency test can't fail | medium | `test_keys.py` |
| 4 | `e81c7a1` | manifest-agreement test is tautological | medium | `test_emotion_fallback.py` |
| 5 | `0b76f67` | atomic-write crash path never exercised | medium | `test_registry_atomic.py` |
| 6 | `b9ca45e` | flaky wall-clock TTFB | medium | `test_streaming.py` |

## What was fixed

1. **The key-store concurrency test proved nothing.** It ran 8×50 `validate_key` calls and asserted the store survived "concurrent read-modify-write" — but `validate_key` debounces its `last_used` persist (60s), so the first call wrote and the other ~399 skipped `_save` entirely. **Exactly one write happened, under the lock: the test would pass with no locking at all.** Now the debounce is disabled in setup so every validate really writes, and `_save` calls are counted (`assertGreater(writes, 100)`) — otherwise the `len(data) == 1` assertion is satisfied by a single serialized write. Runtime 0.10s → 0.51s, consistent with ~400 real writes.
2. **The manifest-agreement test compared a function to itself.** `voices.py` imports `deterministic_fallback` from `emotions`, and `resolve()` calls that same object — so the guard against "voices.py reimplements the fallback independently" (the actual historical bug) would pass if someone did exactly that. Added an explicit `assertIs` identity check — the real structural invariant.
3. **The atomic-write crash path was asserted-but-never-entered.** `AtomicCrashSafetyTests` raised inside the mutation `fn`, but `mutate_meta` runs `fn` **before** `_save_meta` — so no temp file, no `os.replace`, no unlink-on-failure. The tests proved only *ordering* while their names claimed *atomicity*. Added a test that injects the failure **inside** `_save_meta` (`os.replace` raises) and asserts the live registry is byte-identical with no orphaned `._meta-*.tmp`. **Mutation-verified:** green against the real atomic write, **red** when `_save_meta` is regressed to an in-place write.
4. **FakeEngine's `capacity` was a lifetime quota, not backpressure.** `_admitted` was never decremented, so N jobs submitted *sequentially* — each fully completing — still 429'd on N+1, while the real engine releases its permit on completion. Any 429/permit-leak test written against the shared fake asserted a contract the real engine doesn't have. Slot now released in `_work`'s finally; `snapshot()` reports live `in_flight`/`queued` instead of hardcoded zeros.
5. **FakeEngine leaked a thread pool per test case.** `tearDown` only swapped the module reference back. Added `close()` and wired it into the `test_compat`/`test_parallel` tearDowns.
6. **The abandon test raced the engine.** It polled `future.done()` then asserted the semaphore was restored — but the abandon path cancels the future **before** releasing the permit, so a preempted worker made it assert on the pre-release count: an intermittent red on a *correct* engine, looking like a permit leak that isn't real. Now polls to a deadline.
7. **Two tests reached into `threading.Semaphore._value`.** Added `TtsEngine.available_permits()` so the stdlib-internal knowledge lives in `engine.py`; a CPython change or a `BoundedSemaphore` swap can't false-fail them.
8. **The streaming TTFB assertion was a wall-clock bet.** `ttfb < 0.30` measured real thread scheduling against `FakeEngine`'s `time.sleep` workers — on a throttled container the 0.05s first chunk is observed late and the build goes red with no code change. Replaced with a proportional bound (`ttfb < total * 0.5`, ~4× headroom): a uniform slowdown scales both, so it stays honest without flaking.

## Verification

| Gate | Before | After |
|---|---|---|
| Full service suite | 161 tests, **test_compat FAILING** | **163 tests, 0 failures** (17/17 modules) |
| New tests that can actually fail | — | atomic-crash-path (mutation-proven), manifest identity, ≥100-real-writes guard |

## Patterns established (catalogue items 30–33)

30. **A test whose subject debounces/caches may never run the code it asserts.** Count the side effect (writes, calls) and assert it actually happened — otherwise "it passed" means "it did nothing". (test_keys)
31. **Comparing two names that resolve to the same object is a tautology.** If the invariant is "these stay in sync", assert the *identity* (or drive each side through its real public entry point). (manifest agreement)
32. **A "crash mid-write" test must inject the failure INSIDE the write.** Raising in the caller returns before the write path is entered — proving ordering, not atomicity. Mutation-test the guard: break the thing on purpose and confirm the test goes red. (registry atomic)
33. **Assert ordering, not wall-clock, for concurrency; and poll to a deadline for state settled by another thread.** An absolute timing bound measures the machine; a signal (`future.done()`) is only a happens-before edge for state mutated *before* it. (streaming TTFB, abandon)

Plus: **test doubles must mirror the real callee's tolerance** (`**kw`), or a legitimate source change manufactures a fake failure — the exact shape of this wave's regression.

## What remains (per INDEX)

Wave 9 (dead-code/duplication, ~23) is the last themed wave — biggest items: the fully dead traced-glyph subsystem (10 files), `PrototypeTabs`, 12 duplicated proxy handlers, find-character-by-id ×8, triplicated take-loading. The test-file *duplication* findings (svc-tests-a #4/#5, b #3/#4, c #3/#4/#5) belong there too, not here.

Standing defers unchanged: ingest commit/GC lifecycle trio, `keys.py` event-loop cache, `app.py` streaming-errors-swallowed, `takes.py` atomic-write adoption, web-UX/a11y tail, `web-api-keys #3`.
