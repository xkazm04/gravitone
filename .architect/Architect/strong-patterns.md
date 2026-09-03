# Strong Patterns

Load-bearing patterns identified by `/architect`. Ideally these graduate into
docs sections, test guards, or codified conventions.

## Patterns

## Engine job lifecycle discipline

- Identified: 2026-07-26
- Reach: engine.py worker loop + all 4 synthesis endpoints
- Why it works: every future resolved (result/exception/cancel/drain), permits released in `finally`, worker errors sanitized behind a request id with the raw cause logged — callers never hang, workers never leak, clients never see internals.
- Codification status: docs-written (also test-guarded: test_streaming abandon tests, test_replicas AggKeys contract)
- Codified: 2026-07-26
- Codification ADR: [[Architect/decisions/2026-07-26-codify-strong-patterns]]
- Docs at: .claude/CLAUDE.md#load-bearing-conventions
- Examples: `service/engine.py:406-413`, `service/app.py:179` (now via `service/errors.py`)
- **Note (async-patterns scan, same day)**: the discipline was airtight *inside*
  engine.py and absent at its edges — speak/performance cloned the submit-all
  pattern without the abandon half. Fixed in [[2026-07-26-abandon-protocol]];
  the lesson is that this pattern must be applied by every caller, not just
  admired in the engine.

## Honest failure surfaces

- Identified: 2026-07-26
- Reach: 3 modules exemplary → now generalized via lib/apiFetch, ErrorBanner, and the F7 hooks (useMounted, useCopyFeedback, useHealthPoll)
- Why it works: snapshot-rollback with copy that states the true state ("the key is still active"); failures always shown, never swallowed — the product's differentiating honesty rule made mechanical.
- Codification status: docs-written (no web test runner — structural guard not possible; gap noted)
- Codified: 2026-07-26
- Codification ADR: [[Architect/decisions/2026-07-26-codify-strong-patterns]]
- Docs at: .claude/CLAUDE.md#honest-failure-surfaces-web
- Examples: `web/app/keys/_variants/data.ts:74-93`, `web/lib/apiFetch.ts`, `web/components/ui/ErrorBanner.tsx`

## O_EXCL cross-process sentinel

- Identified: 2026-07-26 (async-patterns scan)
- Reach: `takes.py` `.pick` (origin) → generalized as `atomicio.file_lock`, adopted by `voices.mutate_meta`
- Why it works: `os.open(O_CREAT|O_EXCL)` is atomic create-if-absent at the filesystem layer, so it excludes across PROCESSES — the only correct primitive in a topology of N single-worker replicas, where a `threading.Lock` serializes nothing and `os.replace` prevents torn files but not lost updates.
- Codification status: docs-written + test-guarded (`test_file_lock.py`)
- Codified: 2026-07-26
- Codification ADR: [[Architect/decisions/2026-07-26-codify-cross-process-sentinel]]
- Docs at: .claude/CLAUDE.md#cross-process-exclusion-service
- Examples: `service/takes.py:230-245`, `service/atomicio.py::file_lock`, `service/voices.py::mutate_meta`

## Event-loop discipline (post-fix)

- Identified: 2026-07-26 (as the *inverse* of a weakness — app.py's executor
  offloads were correct and everything outside app.py wasn't)
- Reach: 4 upload handlers + 2 auth deps + the synthesis post-processing path
- Why it works: `def` handlers get a threadpool, `async def` gets the one loop; keeping blocking work off the loop is what keeps 33 queued waiters, admission decisions and stream chunks moving.
- Codification status: docs-written + test-guarded (`test_handler_modes.py`)
- Codified: 2026-07-26
- Docs at: .claude/CLAUDE.md#event-loop-discipline-service
- Examples: `service/app.py::_offload`, `service/voices.py::create_voice` (now `def`)
