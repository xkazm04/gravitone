---
slug: backend-truth-reaches-user
type: perfect/direction
context: "[[Voice Creation Studio]]"
lens: feature
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 463140d
---
## What & why
Round 5 built sovereign limits, speech-detection outcomes and measured levels — and they die at the API boundary, so no user has ever seen them. `_analyze` persists only `speakers` and `duration`; `note`, `limits` and `detection` are dropped, and `_PUBLIC_KEYS` has no slot for them. The consequence is that the studio's limits copy is a HAND-MIRRORED DUPLICATE of the backend constant that can drift silently, and a user whose `auto` mode resolved to sovereign never sees the limits at all — they appear only if you clicked the pill yourself. The detection outcome escapes only as `sample_text`, rendered in italic quotation marks as though "no pauses found, the whole recording is one take" were a transcript of the user's own speech.

## Evidence
- `service/ingest_api.py:388` — `_update(job, speakers=res["speakers"], duration=res["duration"], ...)`: `note`, `limits`, `detection` are computed by `sovereign_analyze` (`ingest.py:894-903`) and never persisted. (Director-verified.)
- `service/ingest_api.py:537` — `_PUBLIC_KEYS` has no slot for any of them, so even if persisted they would not be served.
- `web/app/voices/new/page.tsx:248` — the sovereign limits are hand-written prose duplicating `ingest.py:622-632` `SOVEREIGN_LIMITS`.
- `web/app/voices/new/page.tsx:249` — `auto` mode says only "falls back to local processing"; `resolve_mode` (`ingest.py:1245`) can silently resolve to sovereign with none of the three limits shown.
- `web/app/voices/new/page.tsx:284` — the `unbroken` finding (`ingest.py:889-890`) renders as an italic quotation, styled identically to transcript text.

## Acceptance criteria
- `note`, `limits` and `detection` cross the API boundary and reach the browser (persisted in job state AND present in `_PUBLIC_KEYS`).
- The studio CONSUMES `limits` rather than duplicating the constant, so backend and UI cannot drift.
- The detection outcome is presented as a finding about the recording, never styled as a transcript of what was said.
- A job that RESOLVED to sovereign states its limits as prominently as one where the user chose sovereign explicitly.
- The `unbroken` / `silent` / `too_short` outcomes each read as themselves rather than collapsing into one message.

## Risks / non-goals
- Cross-context, PRE-AUTHORIZED: `service/ingest_api.py` belongs to Voice Cloning & Ingest, which is on cooldown for PROPOSING — cooldown does not forbid touching a file when the direction belongs to another context.
- Do not widen the poll payload carelessly: `GET /v1/ingest/{job}` already returns the whole job every tick. Add what is needed, and say if payload size becomes a concern.
- Non-goal: redesigning the sovereign/cloud toggle or the mode-selection UX.

## Build record
Builder W1. `_analyze` now persists `note`/`limits`/`detection` (`res.get(...)` → null in cloud mode, so the client distinguishes "this mode doesn't produce it" from "not computed yet"), the job dict initialises the three keys, and `_PUBLIC_KEYS` serves them — closing the boundary drop that made round 5's sovereign work invisible. New `GET /v1/ingest/modes` serves `SOVEREIGN_LIMITS` and `sovereign_note()` themselves plus `resolve_mode("auto")`, **declared ahead of `/{job_id}`** (which would otherwise swallow the path and answer "job expired") with a test pinning the ordering. The upload panel renders the SERVED limits instead of re-typing them, and states which pipeline `auto` will resolve to on this backend — so a user headed for a resolved-sovereign scan is told before uploading. A failed modes fetch shows a warning banner, never an invented fallback. New `DetectionFinding` gives `spans`/`unbroken`/`silent`/`too_short` each their own headline, shows the measured levels, and never claims a threshold was "derived from this recording" when `adaptive` is false. Sovereign `sample_text` loses the quotation marks and italics that made a finding look like a transcript.

**Director review**: read the boundary diff; the route-ordering trap was the kind of thing that fails at runtime only, and the builder both hit it and pinned it. Payload growth reported unprompted (~600 B of limits + 7 scalars per sovereign poll tick, constant-size, nothing for cloud jobs). One new file outside the listed set — a 9-line `proxyJson` passthrough for the new endpoint — accepted: without it the browser cannot reach the route. Gates: 420 service at build, 469 after the wave; tsc clean, 90 web tests. MERGED.
