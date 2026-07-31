---
slug: flow-state-truth
type: perfect/direction
context: "[[Voice Creation Studio]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 86b77b6
---
## What & why
The create flow's state machine keeps state that is no longer true, and nothing anywhere tests it. An analyze failure spreads the existing state, so the user lands back on the upload screen with a live `result` and `jobId` for a recording the server has already discarded — and the Coverage Coach reads `result?.stems`. `RESET` never clears `committedCid`, so after "start over" the "Extending an existing character" line can render in a brand-new flow. Both are one-line bugs in a PURE REDUCER with no DOM — the single cheapest test target in the repo — and this entire flow currently has zero tests.

## Evidence
- `web/app/voices/new/_state/machine.ts:127` — the error transition spreads prior state, retaining `result` and `jobId`.
- `web/app/voices/new/page.tsx:477` — the Coverage Coach reads `result?.stems`; `page.tsx:232` renders extend copy from `committedCid`.
- `web/app/voices/new/_state/machine.ts:181-190` — `RESET` does not clear `committedCid`.
- Zero test files under `web/app/voices/new/**` (scout ran `find web -name "*.test.ts*"`); `machine.ts`'s `reducer` and `statusToPhase` are pure functions with no DOM.
- `web/lib/useHealthPoll.test.ts` is the proven pattern for testing the poller; `useIngestJob.ts` has no test for 404→expired, stall-after-3, terminal-stop or the backoff ladder.

## Acceptance criteria
- An error clears the state it invalidates — no dead ledger survives onto a screen that implies a live one.
- `RESET` fully resets; a fresh flow cannot render extend copy from a previous commit.
- First tests for `machine.ts`: every transition, including the two bugs above and the `committing`→`review` vs →`upload` error branch.
- First tests for `useIngestJob`: 404→expired, 5xx→stall-after-3, stop-on-terminal, and the backoff ladder.
- The tests pin behaviour, not implementation — a future refactor of the reducer should keep them passing.

## Risks / non-goals
- Fix the bugs AND pin them; a test that documents the current broken behaviour is worse than none.
- Non-goal: rewriting the state machine's shape (round 2 consolidated it deliberately and it is sound) or converting the JSX IIFEs into components.

## Build record
Builder W2. The analyze-failure branch now clears `job`, `jobId`, `result`, `selected` and `pendingCommit`, while the commit-failure branch still keeps the (real) ledger and jobId. `RESET`/start-over returns `initialState` with a fresh `Set`; scan-another is the one continuation and deliberately keeps `committedCid` to pre-arm extend. The upload screen's extend line now renders from `mode === "extend" && extendCid` — what the flow will actually do, rather than what it once did.

36 new tests for a flow that had none: `machine.test.ts` (25) covers every action, both bugs, and the `committing`→review vs →upload split; `useIngestJob.test.ts` (11) covers 404→expired-with-no-reschedule, server-side "expired", stop-on-terminal, 5xx never coerced into a Job, stall-after-3 plus its retraction on first success, and the backoff ladder asserted as SHAPE (prompt first poll, monotonic relaxation, request count well under the tight cadence, reset on step change) so the numbers can move without breaking the tests.

**The builder ran its own anti-vacuous check**: restoring the pre-fix `machine.ts` under the new suite fails EXACTLY the two bug tests (2 failed, 23 passed), working tree restored clean afterwards. That is the check that separates a test that pins a fix from one that documents whatever the code happens to do.

**Director review**: gates on main — tsc clean, **139 web tests across 14 files** (90 at wave start), 469 service unchanged as expected for a web-only change. MERGED.
