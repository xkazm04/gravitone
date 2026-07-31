# Dual-lens scan — svc-tests-a
> Files: 7 | Findings: 5 (crit 0 / high 0 / med 5 / low 0)
> Lenses: bug-hunter + code-refactor

## 1. Abandon test asserts semaphore value it never synchronizes on (flaky race)
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: race-condition
- **File**: `service/tests/test_abandon.py:146`
- **Scenario**: The test polls `while not job_b.future.done()` (lines 134-137), then immediately asserts `self.eng._admit._value == self.eng._max_inflight`. In the engine's abandon path the worker calls `job.future.cancel()` (engine.py:357) and only THEN `self.engine._admit.release()` (engine.py:358). If the worker thread is preempted between those two lines, the poll loop already sees `future.done()==True` and the assertion runs against the pre-release permit count (8 instead of 9).
- **Root cause**: The test's only happens-before edge is `future.done()`, but the state it checks (the admission semaphore) is mutated one statement *after* the future is marked done — so the wake-up signal precedes the state it is used to gate. It also reaches into the private CPython `Semaphore._value`.
- **Impact**: Intermittent CI red on a correct engine; the failure looks like a permit leak that isn't real, eroding trust in the suite.
- **Fix sketch**: Poll `_admit._value` up to a deadline (or expose a public `available_permits()` / drain the queue with `join`) instead of assuming it is settled the instant the future is done; assert via a public accessor rather than `_admit._value`.

## 2. FakeEngine capacity is a lifetime admission cap, not real in-flight backpressure
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: success-theater
- **File**: `service/tests/fake_engine.py:133`
- **Scenario**: `submit` increments `self._admitted` (line 136) and raises `AdmissionRejected` once `_admitted >= capacity` (lines 133-135), but `_admitted` is NEVER decremented — the `_work` finally only touches `_cur` (lines 157-159). A suite that constructs `FakeEngine(capacity=N)` and submits N jobs *sequentially* (each fully completing) still gets a 429 on job N+1, whereas the real `TtsEngine` releases its permit on completion (engine.py:405) and would admit it.
- **Root cause**: The fake models capacity as a cumulative lifetime counter, but the real engine's admission is a semaphore of `workers+queue_max` that is released as jobs finish/abandon/drain. The class docstring claims it faithfully models "the 429 path"; it doesn't for repeated submits. `_FakeMetrics.snapshot()` compounds this by hardcoding `in_flight:0, queued:0` (line 89).
- **Impact**: Any backpressure/429 regression test written against this shared fake passes while asserting the wrong contract — a real permit-leak or premature-reject bug in the engine would go undetected.
- **Fix sketch**: Decrement `_admitted` in the `_work` finally (or cap on live `_cur`), and drive `_FakeMetrics.snapshot()` from the real `_cur`/queue depth so in_flight/queued aren't constant zeros.

## 3. test_compat _Base leaks a ThreadPoolExecutor per test case
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: resource-leak
- **File**: `service/tests/test_compat.py:28`
- **Scenario**: `_Base.setUp` builds a fresh `FakeEngine(workers=2, delay=0.01)` (line 28), whose `__init__` opens a `ThreadPoolExecutor(max_workers=2)` (fake_engine.py:123). `tearDown` (lines 33-35) only restores `appmod.ENGINE = self._orig`; it never shuts the pool. Across the ~12 tests in this module (and every other suite that uses `_Base`) the executors accumulate.
- **Root cause**: `FakeEngine` exposes no `stop()`/`close()` and holds a non-daemon-managed executor, so nothing joins its threads; the test only swaps a module reference and drops the object without draining it.
- **Impact**: Steady thread accumulation during the run; on a large combined suite this can hit the OS thread ceiling or slow the interpreter, and leaked workers may still be resampling into the shared `resample_poly.calls` list during a later test.
- **Fix sketch**: Add `FakeEngine.close()` that calls `self._pool.shutdown(wait=False)` and invoke it in `_Base.tearDown` before restoring `ENGINE`.

## 4. Duplicated clone-endpoint fixture across two test modules
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `service/tests/test_direct_clone_consent.py:36`
- **Scenario**: `test_direct_clone_consent.py` (setUp/tearDown 36-59, `_fake_clean` 61-63, `_fake_export` 65-68, `STATEMENT` 32, `_post` 70-75) is a near-verbatim copy of `test_character_read.py` (setUp/tearDown 30-50, `_fake_clean` 52-55, `_fake_export` 57-59, `STATEMENT` 26, `_clone` 61-67): the same six-patch list (`vc.VOICES_DIR`, `vc.META_PATH`, `ingest.VOICES_DIR`, `ingest.clean_audio`, `vc._wav_seconds→12.0`, `vc.subprocess.run`), the same fake artefact writers, and the same POST helper.
- **Root cause**: Two suites independently stood up the identical "clone a voice with mocked ffmpeg/export into a temp store" harness instead of sharing one.
- **Impact**: Any change to the clone fixture (new patch target, changed export signature) must be edited in two places; drift makes one suite silently stop exercising what it claims.
- **Fix sketch**: Extract a `CloneEndpointBase(unittest.TestCase)` (or a conftest fixture) holding the patch list, `_fake_clean`, `_fake_export`, `STATEMENT`, and a `_post_clone` helper; have both modules subclass it.

## 5. Brittle source-text assertions in test_clone_path.py
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: brittle-setup
- **File**: `service/tests/test_clone_path.py:47`
- **Scenario**: `test_no_divergent_filter_string_survives` (47-55) reads `service/ingest.py`, `service/voices.py` and `clone_test.sh` off disk and greps for the literal `"highpass=f=80,loudnorm"`; `test_create_voice_short_message_is_honest` (57-62) greps `voices.py` for `"at least 3 seconds"`. These assert on source *text*, not behavior.
- **Root cause**: The intent (no denoise-less filter survives; the "too short" message matches the 3s threshold) is checked by string-matching files rather than by exercising `clean_audio`/`create_voice`. `clone_test.sh` is loaded by a fixed relative path, and `import service.voices as vc` (lines 48, 60) is unused in both methods.
- **Impact**: Rewording the user message, i18n, or a behavior-preserving reformat of the ffmpeg chain false-fails; deleting/renaming `clone_test.sh` raises `FileNotFoundError` (a test error unrelated to the code under test). The suite guards a spelling, not a contract.
- **Fix sketch**: Assert behavior — call `clean_audio` and inspect the captured ffmpeg `cmd` for the canonical filter (as `test_clean_audio_uses_the_canonical_filter` already does), and POST a ~2s clip to `/v1/voices` asserting the 422 body says "3 seconds". Drop the `clone_test.sh` disk read and the unused `vc` import.
