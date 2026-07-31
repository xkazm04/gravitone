---
slug: api-clone-consent
type: perfect/direction
context: "[[Voice & Emotion Library]]"
lens: wildcard
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: f9a63c4
---
## What & why
Round 1 gave ingest clones consent receipts, but POST /v1/voices (direct clone) never writes consent — API-cloned voices are permanently consent=False. Require the same attestation (422 without), stamp the same receipt shape (timestamp + clip sha256 + statement), pass through studio upload flows.
## Evidence
voices.py:435-438 (no consent write); useCharacterVoices.ts:98; data.ts:82; HeroMicDemo.tsx:68.
## Acceptance criteria
- direct clones 422 without attestation
- receipt in _meta.json identical in shape to ingest's
- studio + hero-demo upload flows pass attestation
- consent: true for new API clones
## Risks / non-goals
No retroactive receipts; window.confirm consent UI stays (custom modal is a separate direction if ever wanted).
## Build record
Round 2 wave 2, 2026-07-13. Opus builder; Director-reviewed; 119 unittests + tsc green. Commit f9a63c4. One CONSENT_STATEMENT in web/lib/consent.ts imported by all four clone surfaces; receipt shape mirrors ingest exactly.
