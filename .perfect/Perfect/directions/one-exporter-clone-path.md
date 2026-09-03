---
slug: one-exporter-clone-path
type: perfect/direction
context: "[[Voice & Emotion Library]]"
lens: wildcard
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 3707fb4
---
## What & why
Round 1's `one-true-clone-path` shipped as a shared cleanup FILTER, but the two clone paths still use different EXPORT mechanisms. The direct upload spawns the `pocket_tts export-voice` CLI per clone: one cold model load of roughly 15 seconds, and — unlike the exporter the ingest commit uses — no load-back verification. So a serializer or format mismatch produces a voice that registers successfully and then fails later at synthesis time, instead of failing at clone time while the user is still standing there.

## Evidence
- `service/voices.py:600-602` — `create_voice` spawns `python -m pocket_tts export-voice`.
- `service/export_stems.py:96-122` — `_export_one` loads the model ONCE for the whole batch, and does a round-trip load-back check, falling back to the CLI per stem on failure.
- `service/voices.py:591` — the direct path imports `ingest.clean_audio`, so the FILTER is genuinely shared; `service/tests/test_clone_path.py:45-54` enforces that and only that.
- `service/voices.py:580` — the export writes `out_path` before the registry commit, so an unverified voice is on disk before anything checks it (see [[registry-never-silently-empty]]).

## Acceptance criteria
- The direct-upload clone uses the same one-load, load-back-verified exporter as the ingest commit.
- The CLI fallback round 1 deliberately kept as a safety net is preserved, and the condition that triggers it is documented.
- A clone whose embedding cannot be loaded back fails the REQUEST — the user learns now, not at first synthesis — and leaves nothing registered.
- `test_clone_path.py` is extended to pin the shared EXPORTER, not just the shared filter.
- The wall-clock saving on a direct clone is measured and reported, or its absence is stated.

## Risks / non-goals
- Round 1's own lesson applies literally here: when swapping a proven external invocation for an in-process one, keep the fallback to the proven path and require a runtime round-trip check. That is exactly what `export_stems` already does — reuse it, do not re-derive it.
- pocket-tts is not installed on the dev box, so the real export cannot run here; the builder must say what it could not execute.
- Non-goal: changing the ingest commit path, which already works.

## Build record
Builder L2. New `export_stems.export_batch(...)` writes the spec, runs the existing `python -m service.export_stems` child to completion with `subprocess.run` (no two-pipe deadlock, so no drain thread), and parses the per-stem status lines; an emotion with no status line gets the stderr tail as an error rather than silent success. `create_voice` uses it, so the direct clone inherits the **load-back round-trip check and the CLI fallback verbatim**, and `voices.py` no longer spawns `pocket_tts export-voice` at all (its `subprocess`/`sys` imports are gone). `_export_one`'s fallback trigger is now documented. Tests pin the shared EXPORTER — the spawned command, the spec contents, a reported failure and a silent child both failing the request with nothing left behind, and `_export_one`'s load-back / CLI-fallback / both-failed-reports-both behaviour.

**The builder corrected THIS DIRECTION'S OWN VALUE CLAIM, and was right.** The direction justified the change partly on saving "one cold ~15s model load". Its report: *"The wall-clock claim is by construction, not measurement: there is NO saving on a direct clone."* One stem is one cold model load before and after — the one-load win is per-BATCH and belongs to the ingest commit. What actually changed is that the load is now VERIFIED, and the fallback costs a second cold load only on the failure path. Director accepts: the verification was always the stronger half of the case, and the speed claim was padding that did not survive contact. Fourth builder correction of the round.

Also fixed three test files it broke honestly (`test_direct_clone_consent.py`, `test_character_read.py`, `test_registry_integrity.py` all mocked `voices.subprocess.run`, which no longer exists).

**Director review**: gates on main — compileall clean, **509 passed, 81 subtests** (487 before), branch/main parity verified. pocket-tts is absent so no real export ran; every export in the tests is a mocked child process, stated plainly. MERGED.
