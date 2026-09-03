# Dual-lens scan — svc-tests-b
> Files: 6 | Findings: 5 (crit 0 / high 0 / med 4 / low 1)
> Lenses: bug-hunter + code-refactor

## 1. Concurrency test can't fail — debounce means only one write ever happens
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: success-theater / false-coverage
- **File**: `service/tests/test_keys.py:76`
- **Scenario**: `test_concurrent_validate_never_corrupts_store` runs 8×50 = 400 `validate_key` calls across 8 threads, then asserts "the file survived concurrent read-modify-write intact" (`len(data) == 1`). But `validate_key` debounces the file write (`keys.py:170-173`): the first successful validate sets `_LAST_PERSIST[kid]`, and every one of the remaining ~399 calls is inside the 60s window, so it skips `_save` entirely. Exactly ONE `_save` runs, and it runs under `_STORE_LOCK`.
- **Root cause**: The test was written before/without accounting for the debounce it shares a module with; it assumes each `validate_key` writes the file, but the hot path deliberately does not. So no *concurrent* read-modify-write is ever exercised.
- **Impact**: The test would pass even if `_save`/`validate_key` had NO lock at all — it proves nothing about the store surviving concurrent writers, which is the exact auth-critical guarantee it advertises. A real corruption regression (interleaved truncating writes to `api_keys.json`) would ship green.
- **Fix sketch**: Force real concurrent RMW: in setup set `keys._LAST_USED_DEBOUNCE_S = 0` (or clear `keys._LAST_PERSIST` inside the loop) so every validate writes, and/or count `_save` invocations and assert it ran many times across threads while `len(data) == 1`.

## 2. Manifest-vs-resolve "agreement" test is tautological — can't catch the regression it guards
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: false-coverage / masked-regression
- **File**: `service/tests/test_emotion_fallback.py:96`
- **Scenario**: `ManifestAgreementTests` asserts the manifest's advertised fallback equals what `resolve()` picks, by comparing `voices.deterministic_fallback(native)` to `emotions.resolve(...)`. But `voices.py:32` imports `deterministic_fallback` straight from `emotions`, so `service.voices.deterministic_fallback IS service.emotions.deterministic_fallback` — the very same function object — and `resolve()` (`emotions.py:147`) calls that same function internally.
- **Root cause**: The test compares a function to itself routed through `resolve`. The module docstring says the historical bug was voices computing its fallback "independently" so the two "could disagree"; the guard against that recurrence is structurally a no-op.
- **Impact**: If someone reintroduced a separate copy of the fallback logic in `voices.py` (exactly the past bug), this test would still pass — false assurance that manifest and synthesis stay in sync.
- **Fix sketch**: Either assert the identity explicitly (`assertIs(vc.deterministic_fallback, em.deterministic_fallback)`), or drive each side through its real public entry point (`voices.character_manifest(...)` for the advertised fallback vs `resolve(...)` for the runtime pick) so an independent reimplementation is actually detected.

## 3. Duplicated fake-subprocess fixtures + cross-module shared mutable class state
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication / brittle-fixture
- **File**: `service/tests/test_ingest_pipeline.py:148`
- **Scenario**: `CancelPopen` (`test_ingest_pipeline.py:148-170`) is a ~90% copy of `_FakeExportPopen` (`test_ingest_lifecycle.py:19-48`) — same `__init__` reading the spec JSON, same `_gen` writing `b"tensors"` per stem, same `wait/terminate/kill`. Separately, `test_ingest_pipeline.py:125` reaches into the sibling test module to import `_FakeExportPopen` and mutate its class-level `.spawned` counter, which `test_ingest_lifecycle.py:284` also resets.
- **Root cause**: No shared ingest test-double module (the engine tests already have `service/tests/fake_engine.py` for exactly this), so each test file grows its own near-identical fake `Popen`, and one test file depends on another's class-level mutable state.
- **Impact**: Two copies drift independently; the shared `_FakeExportPopen.spawned` class attribute is import-order- and parallel-run-fragile (a future `pytest -n`/`unittest` parallelization would let one test's reset race another's assertion `== 1`). Maintenance burden and a latent flake.
- **Fix sketch**: Extract a single `service/tests/fake_ingest.py` exposing a parametrizable `FakeExportPopen` (with a per-instance/per-test spawn counter injected, not a class global) and import it from both test modules.

## 4. Whole-`SETTINGS` object replacement in the timeout test is a landmine
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: brittle-setup
- **File**: `service/tests/test_errors.py:49`
- **Scenario**: `test_timeout_increments_metric_and_returns_504` sets `appmod.SETTINGS = types.SimpleNamespace(request_timeout_s=0.05)`, discarding every other settings field. It passes today only because the 504 path (`app._await_result`, `app.py:162`) reads a single attribute (`request_timeout_s`) from `service.app`'s SETTINGS binding, while auth (`service/auth.py:33`) reads its own separate `service.auth.SETTINGS` binding that the test never touched.
- **Root cause**: The fixture replaces the entire config object rather than overriding one field, coupling the test to the precise, current set of `SETTINGS.*` reads on that code path across two different module namespaces.
- **Impact**: The moment the synthesis route reads any other `SETTINGS.*` attribute before the timeout fires, this test fails with a confusing `AttributeError` (not a meaningful assertion), or worse, patches over a real change. Brittle and misleading on failure.
- **Fix sketch**: Shallow-clone the real settings and override one field — e.g. `types.SimpleNamespace(**vars(appmod._orig_settings), request_timeout_s=0.05)`, or `dataclasses.replace(real, request_timeout_s=0.05)` if it is a dataclass.

## 5. Drain test asserts on a private CPython semaphore internal (`_admit._value`)
- **Severity**: low
- **Lens**: code-refactor
- **Category**: brittle-assertion
- **File**: `service/tests/test_drain.py:126`
- **Scenario**: `test_stop_resolves_all_futures_and_joins_workers` asserts `self.eng._admit._value == self.eng._max_inflight` to prove all admission permits were returned after drain.
- **Root cause**: `_value` is an undocumented implementation detail of `threading.Semaphore`, not a public API. The test reaches through the engine into stdlib internals to reconstruct "available permits."
- **Impact**: A CPython release that renames/reworks the counter, or a refactor swapping `Semaphore` for `BoundedSemaphore`/a custom admitter, silently breaks the test for reasons unrelated to the code under test — an unhelpful false failure that obscures the real invariant.
- **Fix sketch**: Have the engine expose a small public accessor (e.g. `available_permits()` returning `self._admit._value`, or track free permits explicitly) and assert against that; keep the internal-attribute knowledge inside `engine.py`.
