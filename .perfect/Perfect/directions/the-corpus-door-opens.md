---
slug: the-corpus-door-opens
type: perfect/direction
context: "[[voice-creation-studio]]"
lens: feature
status: shipped
size: M
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: 2c32391
---
## What & why
The sovereignty loop is fully built server-side — corpus opt-in, capture-after-consent, per-character corpus view with measured fidelity + consent receipt, delete-that-returns-a-report, rederive without re-upload — and the web sends/proxies/renders NONE of it. The entire voice-corpus moonshot is dead code until this door opens. The consent checkbox is exactly the moment the backend designed the opt-in for.

## Evidence
- service: ingest_api.py:1038 scan corpus flag; :1583 CommitReq.corpus; :1728 GET corpus; :1744 DELETE; :1659 rederive
- web: page.tsx:235-237 form sends file+mode only; :320 commit body no corpus; zero corpus proxies; machine.ts Job type has no corpus field

## Acceptance criteria
- Consent step gains keep-my-audio opt-in; scan AND commit send `corpus`; the service's named outcome ("kept N clips…" / "not requested") renders on completion.
- New proxies (corpus GET/DELETE, rederive POST) with real error passthrough.
- Character page gains a corpus panel: clips with seconds/emotions/fidelity + consent receipt, delete shows the service's deletion report, rederive starts the pollable job (reuse useIngestJob).
- Narrow pre-authorized mounts outside the context (character page lives in Character & Voice Mgmt files).
- Tests: proxies, opt-in round-trip, panel states.

## Risks / non-goals
Non-goal: prune UI, global caps (ops decision). Legacy characters without corpus must render an honest empty state, not an error.

## Build record
(pending)
