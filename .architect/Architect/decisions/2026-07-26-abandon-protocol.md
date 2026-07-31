---
date: 2026-07-26
slug: abandon-protocol
status: in-progress
type: structural-bug-class
reach: "2 routes (speak, performance) / 3 gaps: gather-siblings, partial-submit, client-disconnect"
risk: 2
effort: s
payoff: 4
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-async-patterns]]"
---

# speak/performance never abandon sibling jobs

## Context
`Job.abandoned` lets a worker skip an un-started job (`engine.py:358-367`), and
the streaming route applies it correctly in a `finally` (`app.py:528-533`,
test-pinned). Three places don't:
1. `asyncio.gather` in `/v1/speak` (`app.py:613`) and `/v1/performance` (`:699`):
   when one segment 504s/500s, gather cancels the sibling *coroutines* but the
   already-queued `concurrent.futures.Future`s run to completion for a response
   nobody reads.
2. Partial admission rejection: the job list is built in a comprehension, so a
   mid-list `AdmissionRejected` drops the already-submitted jobs on the floor
   (`app.py:607-611`, `:693-697`) — the comment even acknowledges the waste.
3. `engine.py:291` and `app.py:174` both document abandonment on "client
   disconnect", which is implemented nowhere.

## Decision
Two shared helpers in `app.py`: `_submit_batch()` (abandons what it already
submitted before re-raising `AdmissionRejected`) and `_gather_results()`
(`try/except BaseException` → abandon every job in the batch → re-raise).
Because Starlette cancels the handler task when the client hangs up, the
`BaseException` arm catches `CancelledError` too — so gap 3 is closed by the
same code for the batch routes. For the single-job routes, `_await_result`
gains a `CancelledError` arm that sets `abandoned` and re-raises, mirroring its
existing `TimeoutError` arm.

## Consequences
Positive: a failed/abandoned multi-segment request stops burning worker slots —
directly improves the metric the load harness scores (queue depth under
failure); the documented disconnect contract becomes true.
Negative/risks: setting `abandoned` on already-completed jobs is a no-op (the
worker only checks before synthesis), so the blanket sweep is safe; catching
`BaseException` must always re-raise (it does) or cancellation semantics break.
Mitigations: tests assert both the failure path and that success is unaffected.

## Rollout
1. `_submit_batch` + `_gather_results` + `_await_result` cancel arm; migrate both routes — compileall + full suite.
2. Tests: sibling abandon on segment failure; abandon on partial admission rejection — suite green above baseline.

## Acceptance criteria
- A failing segment in speak/performance leaves every sibling job `abandoned`.
- A mid-list `AdmissionRejected` abandons the jobs already submitted.
- Client disconnect (task cancellation) abandons in-flight batch and unary jobs.

## Regression checklist
- [ ] Happy-path speak/performance unchanged (existing tests).
- [ ] Streaming route untouched.

## Pre-flight baseline
compileall clean; 188 tests OK; tree clean on main @ 5345246.
