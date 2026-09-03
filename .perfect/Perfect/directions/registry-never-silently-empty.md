---
slug: registry-never-silently-empty
type: perfect/direction
context: "[[Voice & Emotion Library]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 401a12a
---
## What & why
A corrupt `_meta.json` currently deletes the user's library. `_load_meta` returns an empty skeleton on `JSONDecodeError` — every character silently disappears — and then the next `mutate_meta` writes that empty skeleton over the file, making the loss permanent. `demand.py` faced the same choice and at least logs. The same shape appears in the convergence paths: an orphan embedding becomes a phantom character, and a registry-only ghost can never be deleted through the API.

## Evidence
- `service/voices.py:148-149` — `except JSONDecodeError: return` an empty skeleton; `mutate_meta` (`:218-242`) then loads, mutates and saves that skeleton over the real file.
- `service/demand.py:39-43` — the same situation, but logged.
- `service/voices.py:580` vs `:640` — `create_voice` writes the `.safetensors` BEFORE the registry commit; a `file_lock` `TimeoutError` or an `OSError` in `_save_meta` leaves the file, and the glob-driven read (`:291-301`) turns it into a Voice plus a phantom Character slugged from the voice id.
- `service/voices.py:715-717` — `DELETE /v1/voices/{id}` 404s when the FILE is missing, before touching meta, so a registry row whose file vanished out-of-band is unremovable through the API.
- `service/voices.py:742` — `DELETE /v1/characters/{id}` unlinks inside the mutation function and before `_save_meta`; a mid-loop unlink failure leaves N-1 files gone and the registry claiming all N exist.
- `service/voices.py:704-709` — `remove_voices` pops meta rows first and unlinks after, logging (not raising) on failure, so a file that refuses to unlink resurrects as a phantom while `ingest_api._rollback` has already logged "rolled back".

## Acceptance criteria
- A corrupt registry fails LOUDLY and is never overwritten with an empty one — the operator keeps the damaged file and is told where it is.
- An orphan embedding and a registry-only ghost are both resolvable through the API rather than by hand-editing JSON.
- Deletion orders its side effects so that a partial failure leaves the registry and the filesystem agreeing, or leaves the registry untouched — never claiming files that are gone.
- Tests cover: corrupt JSON does not empty the roster and does not get overwritten; a commit failure after the file write does not strand a phantom; deleting a voice whose file is already gone succeeds.

## Risks / non-goals
- Do not "repair" a corrupt registry automatically — the honest move is to refuse and keep the bytes. Silent recovery is how the data was lost in the first place.
- The write/commit ordering is concurrency-sensitive: `mutate_meta` is the only writer and must stay that way (CLAUDE.md § Cross-process exclusion).
- Non-goal: a migration tool or a backup mechanism.

## Build record
Builder L2. `_load_meta` raises the new `RegistryCorrupt` (an `HTTPException`, 503) on `JSONDecodeError` instead of returning an empty skeleton: the mutation fn never runs, `_save_meta` is never reached, the damaged bytes stay byte-identical. **No automatic repair, by design.** `create_voice` now exports the embedding into the clone's TEMP dir, commits the registry row, then `shutil.move`s the file into `VOICES_DIR` — a failed commit takes the staged file with it (no phantom Character) and a failed move retracts the row via `remove_voices`. New `_unlink_then_forget(meta, ids)` is the single deletion ordering for `delete_voice`, `delete_character` and `remove_voices`: unlink first, drop the row only if the file really went away, never raise out of the mutation fn (raising there would discard the deletions that DID succeed). Partial failures report a sanitized 500 instead of a lying 204. `DELETE /v1/voices/{id}` no longer 404s on a missing file — either half is enough to delete, so registry ghosts and orphan embeddings are both API-resolvable.

**Operator view of a corrupt registry** (the builder was asked to state this and did): reads and writes fail 503 with "the voice registry is unreadable; it has been left untouched rather than replaced — see the server log for the file to repair"; the log names the absolute path and the parse error. Recovery is manual and deliberate.

**Director review**: read `_unlink_then_forget` in full — the "never raises inside a mutation fn" reasoning is exactly right and is the kind of thing that would have been a silent data-loss bug if inverted. Gates on main: compileall clean, **509 passed, 81 subtests**; branch/main parity verified. MERGED.

**Residual risks recorded, all builder-flagged**: the 503 is service-wide while the file is damaged (a hard outage, intended but real, and one ERROR log per affected request); a millisecond window in `create_voice` where a voice is registered but not yet glob-visible; and `shutil.move` across filesystems is copy+delete, so a crash mid-move can leave a row without a file — deletable through the API by design, but a new narrow way to produce one.
