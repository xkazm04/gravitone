---
slug: consent-receipts
type: perfect/direction
context: "[[Voice Cloning & Ingest Pipeline]]"
lens: feature
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: b972668
---
## What & why
Consent is client-side only: attestation checkbox disables a UI button; commit performs no server check — a direct API caller clones a voice with zero record. Require consent attestation in the commit payload, persist a consent receipt (timestamp + clip SHA-256 + attestation text) in _meta.json, reject commits without it.
## Evidence
page.tsx:317; ingest_api.py:171-185; voices.py _meta.json layout (voices.py:100-106).
## Acceptance criteria
- commit 422s without attestation
- receipt (timestamp + clip sha256 + text) stored in _meta.json
- /v1/voices exposes consent: true
- existing voices unaffected
- web commit route passes attestation through
## Risks / non-goals
No cryptographic signing (packs.py notes keypair signing is a follow-up); no retroactive receipts.
## Build record
Wave 1, 2026-07-13. Opus builder; Director-reviewed diff; gates green (compileall + unittest + tsc). Commit b972668.
