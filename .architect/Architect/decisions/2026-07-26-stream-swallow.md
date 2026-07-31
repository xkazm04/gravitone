---
date: 2026-07-26
slug: stream-swallow
status: shipped
commits: [ceeb6eb]
type: structural-bug-class
reach: "1 path (streaming endpoint, flagship) / 1 catch site / 0 tests"
risk: 2
effort: s
payoff: 4
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-error-handling]]"
---

# Streaming generator swallows every mid-flight failure, unlogged

## Context
`app.py:478` catches `(asyncio.TimeoutError, Exception)` inside the streaming
generator and bare-returns: the tuple is redundant, no logging happens (the
module logger sits 400 lines up and is used for exactly this at `app.py:183`),
mid-stream timeouts skip the `on_timeout()` metric the non-stream path counts,
and a drain (`ShuttingDown`) is indistinguishable from a bug. The client
correctly gets a truncated stream (status already committed — nothing else is
possible); the operator gets nothing. `test_streaming.py` covers pre-stream 429
and happy path only; the `jobs[consumed:]` abandon cleanup is unverified for
`consumed > 0`.

## Decision
Split the catch into three: TimeoutError (count `on_timeout()`, log), ShuttingDown
(info log — expected during drain), Exception (request-id + `exc_info` log,
matching the `app.py:179-188` sanitized-500 pattern). Truncation behavior
unchanged. Add a test that fails segment 2 of 3 and asserts the stream truncates
after segment 1's bytes AND job 3 is marked abandoned.

## Consequences
Positive: mid-stream failures observable; metric parity with non-stream path;
abandon cleanup pinned by test. Negative/risks: none material — no contract
change, log volume only on failure. Mitigations: log at info for drain so
shutdown isn't noisy.

## Rollout
1. Split the except; add logging + timeout metric — `python -m compileall -q service` + full unittest suite.
2. Add mid-stream failure test to `test_streaming.py` — suite green at baseline+1.

## Acceptance criteria
- A worker exception mid-stream produces a `logger.error` with request id and traceback.
- Mid-stream timeout increments the timeout metric.
- New test drives a post-first-chunk failure and asserts truncation + abandonment.

## Regression checklist
- [ ] Happy-path streaming tests still pass — full suite run.
- [ ] Pre-stream 429 unchanged — existing test.

## Pre-flight baseline
compileall clean; 164 tests OK; tsc clean. Tree clean on main @ ff171a0.
