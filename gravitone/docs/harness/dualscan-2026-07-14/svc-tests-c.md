# Dual-lens scan — svc-tests-c
> Files: 6 | Findings: 5 (crit 0 / high 0 / med 3 / low 2)
> Lenses: bug-hunter + code-refactor

## 1. Atomic-write crash-safety tests never exercise `_save_meta` — they raise in `fn` before any temp file is created
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: false-confidence / missing-coverage
- **File**: `service/tests/test_registry_atomic.py:89`
- **Scenario**: `AtomicCrashSafetyTests` simulates a "crash mid-write" by raising a `RuntimeError` *inside the mutation `fn`* (lines 78-83 and 93-94). But `mutate_meta` runs `result = fn(meta)` **before** `_save_meta(meta)` (`voices.py:224-225`), so when `fn` raises, `_save_meta` is never called — no temp file is ever `mkstemp`'d, no `os.replace` happens.
- **Root cause**: The tests conflate two guarantees. They actually prove only the *ordering* guarantee (a failed `fn` skips the save), but their docstrings/names ("`_save_meta` replaces the registry atomically", "no stray tmp files after writes") claim the *atomicity* guarantee. `_save_meta`'s real crash path — a failure during `f.write`/`os.replace` and its `except BaseException: os.unlink(tmp)` cleanup branch (`voices.py:175-180`) — is never entered by any test in this file.
- **Impact**: A regression that broke the atomic replace (e.g. writing in place, or dropping the temp-file cleanup and orphaning `._meta-*.tmp` files, or truncating the live registry on a mid-write crash) would ship green. This is the exact data-loss scenario the registry's atomicity is meant to prevent (losing all cloned-voice metadata), yet it is asserted-but-untested.
- **Fix sketch**: Add a test that forces a failure *inside* `_save_meta` — e.g. `mock.patch("os.replace", side_effect=OSError)` (or patch the temp `f.write`) around a `mutate_meta` call, then assert (a) the previous `_meta.json` bytes are unchanged and (b) no `._meta-*.tmp` leftovers remain. That genuinely exercises the temp-file + `os.replace` + `unlink`-on-failure path.

## 2. Wall-clock TTFB assertions make the streaming test timing-dependent (flaky on loaded CI)
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: flaky-test
- **File**: `service/tests/test_streaming.py:54`
- **Scenario**: `test_first_chunk_before_last_segment_finishes` drives the real streaming generator against `FakeEngine`, whose worker threads use real `time.sleep(delay)` (`fake_engine.py:143`), and measures `ttfb` with `time.perf_counter()`. It then asserts `ttfb < 0.30` and `ttfb < total - 0.10`. seg0's delay is 0.05s.
- **Root cause**: The test's correctness depends on real thread scheduling and wall-clock latency rather than a virtual clock. Under CPU-throttled containers, GC pauses, GIL contention, or Windows thread-wakeup jitter, the 0.05s first chunk can be observed well past the 0.30s bar. (The pure-logic sibling `loadtest._measure_stream_timing` is tested with an injected clock in `test_loadtest.py:150-179` — proof the deterministic pattern was available but not used here.)
- **Impact**: Intermittent red builds with no code change; erodes trust in the suite and invites `--rerun`/skip habits that then mask genuine regressions. The parallel-occupancy tests (`test_parallel.py:39-54`, `80-95`, `delay=0.2`) share the same real-sleep fragility, though with more headroom.
- **Fix sketch**: Assert *ordering* rather than absolute wall-clock — e.g. that the first non-empty chunk is yielded before the slow segments' futures resolve — or inject a virtual clock into the streaming path as `_measure_stream_timing` already supports. If a wall-clock bound is kept, widen it substantially and mark the test as timing-sensitive.

## 3. Duplicated `_Registry` test fixture across two files
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `service/tests/test_registry_atomic.py:24`
- **Scenario**: `test_registry_atomic.py:24-41` and `test_registry_cache.py:38-56` each define a `_Registry` context manager that `mock.patch.object`s `vc.VOICES_DIR` and `vc.META_PATH` onto a temp dir. The cache copy additionally resets the module cache globals in `__enter__`; otherwise the two are line-for-line identical.
- **Root cause**: Copy-paste of a shared registry-isolation fixture rather than importing one helper. Any future change to the registry's patch surface (a new module-level path/global) must be edited in two places or the fixtures silently drift.
- **Impact**: Maintenance debt and drift risk; a partial edit leaves one suite patching an incomplete surface, producing tests that pass against the wrong (real) `VOICES_DIR`.
- **Fix sketch**: Extract one helper, e.g. `service/tests/registry_fixture.py` exposing `registry(root, *, reset_cache=False)`, and import it in both files. The cache reset becomes the opt-in flag.

## 4. Duplicated setUp/tearDown between the two parallel test classes
- **Severity**: low
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `service/tests/test_parallel.py:28`
- **Scenario**: `ParallelSpeakTests.setUp/tearDown` (lines 28-38) and `ParallelPerformanceTests.setUp/tearDown` (lines 69-79) are byte-identical: they save/restore `appmod.ENGINE` + `appmod.emotion_map`, stub `emotion_map` to `dict(_EMAP)`, and build a `TestClient`.
- **Root cause**: Two sibling `TestCase`s repeat the same engine/emotion-map harness instead of sharing a base class.
- **Impact**: Minor maintainability debt; the two copies can drift (one restoring `emotion_map`, the other not) and leak global state across tests.
- **Fix sketch**: Introduce a shared `class _EngineHarness(unittest.TestCase)` with the common `setUp/tearDown`, and have both classes inherit it.

## 5. Two near-identical "unreachable metrics → {}" tests perform real network I/O to port 1
- **Severity**: low
- **Lens**: bug-hunter
- **Category**: real-io / duplication
- **File**: `service/tests/test_loadtest.py:140`
- **Scenario**: `ScrapePoolTotalsTests.test_unreachable_metrics_port_returns_empty` (lines 140-144) and `SingleServerMetricsScrapeTests.test_unreachable_metrics_returns_empty` (lines 338-343) both `asyncio.run` a real `httpx` GET against `http://127.0.0.1:1/metrics` and assert `{}`. They exercise the two nearly-identical helpers `_scrape_pool_totals` / `_scrape_server_metrics`.
- **Root cause**: A file that advertises itself as "pure-logic, no server, no torch import" still makes real outbound socket connects. On a box where a firewall DROPs (rather than REJECTs) loopback:1, each connect blocks up to the httpx `timeout=5` before returning `{}` — slow, and environment-dependent.
- **Impact**: Occasional slowness/hangs and cross-machine variability in a suite that is otherwise deterministic; also redundant coverage of two copy-paste helpers.
- **Fix sketch**: Inject a fake async client (or `mock.patch` `httpx.AsyncClient`) that raises `ConnectError`, and parametrize the single assertion over both helpers — no real socket, no timeout dependency. (The helper pair itself is duplication worth consolidating in `loadtest.py`.)
