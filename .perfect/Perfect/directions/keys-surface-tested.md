---
slug: keys-surface-tested
type: perfect/direction
context: "[[API Key Management]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-29
accepted: 2026-07-29
shipped: 2026-07-29
commit: 69c4d8e
---
## What & why
Zero tests touch `web/app/keys/**` or `web/app/api/keys/**` — no coverage of the ledger hook, the create/rotate/delete proxies, the reveal modal, the migration kit, or `switchkit.ts` (which renders into the reveal modal, the profile AND the landing page). The backend is the opposite: round 4 added 182 lines to `test_keys.py` covering revoke-while-listed, unrotatable-after-revoke, cross-process locking and debounce interactions — every one of those behaviours invisible in the studio. Two live bugs sit in the gap.

## Evidence
- No test file under `web/app/keys/` or `web/app/api/keys/` (scout-enumerated across all 18 web test files).
- `web/app/keys/_variants/data.ts:82-101` — `deleteKey` is the only mutation with NO in-flight gate and no `useMounted` guard on its `setKeys`/`setError` (`:91-99`), unlike `refresh` (`:48`).
- `web/app/keys/_variants/KeysLedger.tsx:84` — the empty state can render "No keys yet — create one above." alongside a real error banner (`:44`): a false empty state stacked on a failure.
- `web/lib/switchkit.ts` — rendered in three places, no test at all.
- Indirect coverage only: `lib/apiFetch.test.ts` (the `throwDetail` contract this surface relies on) and `lib/useCopyFeedback.test.ts` (the hook `SecretReveal` notably does not use).

## Acceptance criteria
- The two live bugs are fixed: the ungated destructive mutation and the false empty state.
- First tests cover the ledger's mutation paths — including revoke-vs-destroy once that distinction exists — the proxy handlers, and the reveal modal's copy and dismiss behaviour.
- The tests pin BEHAVIOUR, not implementation.
- An anti-vacuous check confirms each fix's test fails when the fix is reverted; report the result, including any that do not.

## Risks / non-goals
- Coordinate with the sibling directions: revoke-vs-destroy and the reveal modal's behaviour are being changed in the same wave — test the new behaviour, not the old.
- Non-goal: refactoring the ledger to make it testable; take the smallest seam needed and say why.

## Build record
Builder K2. First tests for the keys surface (462 lines across three files) —
and they found a bug nothing else could: `useCopyFeedback` defaulted its target
key to `""`, which is FALSY, so every keyless call site sat on the idle label
forever and the "copy blocked" branch could never render at all. Seven
surfaces: SecretReveal, MigrationKit, SwitchKit, ApiPanel, TakeCode, UserMenu,
BenchmarksView. The hook's own existing test passed throughout because it
asserted `not.toBeNull()`, which "" satisfies — implementation pinned,
behaviour missed. Director teeth-checked the fix: reverting the sentinel turns
2 tests red. Also fixed rotate disabling only its own row while the handler
guarded globally, making every other row a silent no-op.
