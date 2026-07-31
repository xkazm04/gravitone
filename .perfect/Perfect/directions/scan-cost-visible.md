---
slug: scan-cost-visible
type: perfect/direction
context: "[[Voice Creation Studio]]"
lens: feature
status: rejected
size: M
proposed: 2026-07-28
accepted: —
shipped: —
commit: —
---
## What & why
PROPOSED AND REJECTED 2026-07-28 (round 6). The `Spend` ledger — calls per provider, retries, escalations — is computed and published on `partial`, and the web `Partial` type has no field for it, so a user never learns a cloud scan cost 2 ElevenLabs + 5 Gemini calls, nor that a sovereign scan cost zero. Per-segment `escalation: escalated|skipped|failed` is likewise emitted and unrendered.

## Evidence
- `service/ingest.py:335-397` (`Spend`), published at `:387` and `ingest_api.py:387`; `web/app/voices/new/_loaders/shared.tsx:6-19` — `Partial` has no `spend` field.
- `service/ingest.py:1226-1228` — per-segment escalation status; `machine.ts:22` `Result` has no `segments`.

## Acceptance criteria
(not built)

## Risks / non-goals
**Rejection reason (Director's reading)**: this is the FOURTH cost/usage-telemetry direction the gate has declined — after `per-key-usage-metering` (round 1), `one-truth-metrics` (round 1) and `priority-lanes` (round 1). The consistent signal is that surfacing consumption/telemetry to the user is not the product this user is building, even when the data is already computed and the framing is privacy-positive (sovereign's zero). **Promoted to `config.md` → User taste: do not propose cost/usage/telemetry surfaces again without a specific new reason.** The underlying data stays available for operators via the job payload; nothing is lost, it simply does not become UI.

## Build record
Not built — rejected at the gate.
