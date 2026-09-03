---
date: 2026-07-26
slug: cancelled-commit-rollback
status: in-progress
type: structural-bug-class
reach: "1 teardown path (_do_commit cancel arm) + 1 new registry primitive"
risk: 3
effort: m
payoff: 3
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-async-patterns]]"
---

# A cancelled ingest commit left a live partial Character

## Context
Deferred from [[2026-07-26-ingest-teardown]], which made the problem loud but
did not fix it. `ingest.commit` registers each emotion through `mutate_meta` as
it finishes (`ingest.py:569-572`), then checks the cancel flag between
emotions. Cancelling (DELETE, or GC reaping an over-TTL job) tears down the
**workdir** — it never touches `VOICES_DIR`. So a user who cancelled halfway
was silently left owning a partial Character: real registry entries, real
`.safetensors` on disk, none of it asked for.

## Decision
New `voices.remove_voices(ids) -> removed_ids`: pops exactly those registry
entries under the existing thread + cross-process lock, unlinks their
embeddings, and drops a Character only if the removal emptied it. Deliberately
**id-scoped**, because the dangerous failure mode is over-deletion — a
cancelled *extend* must leave the character's pre-existing Voices untouched.
Best-effort on the file layer (it runs on a teardown path): an unlinkable file
is logged, not raised.

`_do_commit`'s cancel arm calls it, logs how many of how many were rolled back,
and — if the rollback itself throws — logs `ROLLBACK FAILED` with the ids at
`error` level, because at that point the voices are live and the user believes
they cancelled.

## Consequences
Positive: cancel now means cancel; the "loud but unfixed" note from the earlier
ADR is resolved. Negative/risks: this is the session's only *destructive*
change — it deletes registry rows and embedding files. Mitigations: scoped to
ids this commit created and returned; 7 unit tests on the primitive (including
two explicit over-deletion guards) plus 3 on the wiring; the failure path is
loud rather than silent.
**Not covered**: a commit that *errors* mid-way still leaves what succeeded —
`ingest.commit` raises without returning the created list, so the ids aren't
available. Arguably correct (an error isn't a user asking to undo), but it is a
real remaining case; recorded in weak-patterns rather than pretended away.

## Rollout
1. `voices.remove_voices` + 7 tests — suite green.
2. `_do_commit` wiring + 3 tests — 219 tests OK.

## Acceptance criteria
- Cancelled commit removes exactly the voices it created. ✅ test
- A cancelled extend keeps pre-existing voices AND the character. ✅ test
- Successful commit rolls back nothing. ✅ test
- Rollback failure logs `ROLLBACK FAILED` with the ids. ✅ test
- Unknown ids / missing files don't raise. ✅ tests

## Regression checklist
- [x] 219 tests OK; no test writes the repo's real registry (checked `git status` after the run — an earlier version of this change did).
- [ ] Real cancel against a running clone — UNVERIFIED (no local TTS runtime). This is the one destructive path shipped today; verify on a box with the runtime before relying on it.
