---
slug: one-video-many-characters
type: perfect/direction
context: "[[Voice Cloning & Ingest Pipeline]]"
lens: feature
size: M
status: shipped
proposed: 2026-08-06
accepted: 2026-08-06
shipped: 2026-08-07
commit: 0a6c1d5
---
## What & why
Relax the single-speaker narrowing: after analysis, the speaker screen becomes a casting board — multi-select which speakers become Characters, name each (per-speaker previews already render), and the service fans labelling+commit over each selection against the SAME cleaned audio and segments. One video, one paid Scribe+Isolator call, N Characters. The hackathon headline.

## Evidence
- Analysis already computes per-speaker stats + previews for ALL speakers (`ingest.py:1063-1074`).
- Narrowing: `POST /{job}/speaker` takes a single id, 409s once labelling starts (`ingest_api.py:1844-1856`); `label_and_stem` filters to one target (`ingest.py:1466`); commit = 1 Character (`:2306-2363`).
- Artifacts survive: analyze's `finally` unlinks only the uploaded source (`ingest_api.py:1363`); `clean.wav` + `segments.json` remain — exactly what `label_and_stem` reads.

## Acceptance criteria
- N speakers selectable and nameable on the casting screen; single-speaker flow unchanged for one selection.
- Scribe/Isolator NOT re-invoked for extra speakers — labelling/commit loop over the shared workdir artifacts (verifiable in the spend ledger/tests).
- Each committed Character carries consent receipt + provenance identical to today's contract.
- Partial failure honest: speaker 2 of 3 fails → the other two exist and the UI says exactly that (no all-or-nothing lie, no silent drop).
- Replica affinity respected (same job, same process); `MAX_ACTIVE_JOBS` accounting stays truthful; job lifecycle/GC handles the longer multi-commit phase.

## Risks / non-goals
- N×M emotion labelling multiplies Gemini spend — the round-10 budget machinery must cover the fan-out (per-JOB budget applies to the whole cast).
- Non-goal: cross-job merging of speakers, re-analysis, or speaker re-clustering UI.
- Sequenced with [[the-link-becomes-a-voice]] (same files) — V-B forks after V-A merges.

## Build record
Builder V-B → 31ccc47, picked as **0a6c1d5**. Shape: new `POST /v1/ingest/{job}/cast` (members list + one up-front attestation), NOT a list-accepting /speaker — /speaker leads to the editable review ledger, cast clones everything eligible; both exits leave awaiting_speaker so the existing 409 covers whichever arrives second. Mechanism: `label_and_stem(source_dir=)` splits where-analyzed-audio-is from where-this-speaker's-work-goes; default None byte-identical. 29 tests: scribe/isolate patched to RAISE (proves no paid re-invocation); one Spend for the whole cast, budget exhaustion degrades honestly (flash labels + amber note); partial failure = per-member rollback via _rollback, others survive, done/failed counted; receipts per Character incl. EXTERNAL_STATEMENT rule; "casting" in ACTIVE_STATUSES (one slot, running TTL, restart _reconcile rolls back the half-cloned member only); sovereign cast works with total_calls==0. Stated decisions accepted: corpus REFUSED for casts (one tick must not retain N people's audio — named reason), MAX_CAST_MEMBERS=6, cancel keeps finished Characters. Unverified locally: real multi-member clone timing (torch absent; ~15s/model-load estimate untimed). Director gates on main: full suite 2131 + tsc + full web 1385. Verdict: merge.
