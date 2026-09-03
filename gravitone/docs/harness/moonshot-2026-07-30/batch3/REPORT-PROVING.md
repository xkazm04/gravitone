# REPORT — PROVING (Proving Ledger), Batch 3

> Saved by the orchestrator from the builder's inline report.

**Status: complete.** Posture measured, not guessed; scope chips proven-vs-declared.

Files — new: `web/app/keys/_variants/probes.ts` (E2 core + probe plan), `attestation.ts`
(localStorage proofs, staleness/posture-drift retirement), `ProvingSweep.tsx`,
`web/app/api/keys/probe/route.ts` (GET posture / POST sweep, serialized, capped at 7),
`scripts/prove-keys.mjs` (JSON; exit 1 on REFUSED-SCOPE-SERVED or open posture, 2
unreachable), + 3 test files. Edited: `backend.ts` (E1 `bare` opt-out), `data.ts`,
`KeysLedger.tsx`, `SecretReveal.tsx`.

Tests: tsc clean; keys suites 69/69; full vitest 526/527 — the 1 red is
`lib/serviceHeaders.test.ts` (drift gate catching VERIFIED's new X-Fidelity-*/
X-Alignment-Cache headers → orchestrator adds them to SERVICE_EXPOSED_HEADERS).
`test_auth` + new `test_auth_distinction` green (12).

## Hooks
1. **401-vs-403 NOT distinguishable** — `_authorize` returns identical 401 for no-key and
   wrong-scope. Builder scoped honestly: negative probes reported conclusive only when a
   positive probe was served in the same sweep (`negativesAreConclusive`, surfaced in UI
   copy). Orchestrator to apply the CLEAN service fix: make key recognition separable from
   scope check (e.g. `keys.validate_key` returns the matched entry or a `key_recognized()`
   helper), then `_authorize` raises 403 recognized-but-unscoped, 401 otherwise. Update
   test_auth_distinction to assert the 403 once applied.
2. Deviation accepted: ONE secretless posture probe runs on page load (single unauth GET,
   no synth); the full sweep remains explicit-action-only.
