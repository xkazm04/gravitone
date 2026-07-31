---
slug: builtin-name-collision
type: perfect/direction
context: "[[Voice & Emotion Library]]"
lens: robustness
status: shipped
size: S
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: d329aec
---
## What & why
Clone your own voice, call it "Mary", and it disappears. `_build_characters` assembles the cloned characters and THEN loops the built-ins writing `chars[vid] = Character(...)` unconditionally, clobbering any cloned character whose id collides. The built-in ids are ordinary first names — mary, jane, michael, eve, paul, george, anna, charles, vera, alba, jean — so this is a name a real user will pick. The clone succeeds, returns 201, the file and the registry row are both on disk, and then the character is simply not in the roster: `/v1/characters/mary`, `emotion_map("mary")` and `/v1/speak` all see only the premade.

## Evidence
- `service/voices.py:353-360` — the `for vid, lang in BUILTIN:` loop runs AFTER the cloned assembly and assigns `chars[vid]` with no membership check. (Director-verified.)
- `service/voices.py:45-52` — `BUILTIN` includes `alba, anna, vera, charles, paul, george, mary, jane, michael, eve, jean, lola, …`.
- `service/voices.py:273-275` — `character_id = _slug(name)`, so the display name "Mary" becomes the id `mary`.
- `service/voices.py:573` — `create_voice` has no BUILTIN-collision guard; its 409 re-check under the lock (`:617-621`) only compares against cloned rows.
- `service/packs.py:158-161` — import's "already exists" check scans only cloned ids, so an import collides the same way.
- No test constructs a cloned character named after a built-in.

## Acceptance criteria
- A cloned character can never be silently replaced by a built-in. Either creation is refused with a message that names the conflict, or cloned wins and the built-in yields — but the choice is explicit, documented, and the same for both `create_voice` and `import_pack`.
- Whichever way it resolves, no data becomes unreachable: a user who already has a colliding clone on disk can still see and delete it.
- A test clones a character named after a built-in (and imports one) and asserts the outcome.
- The 409/refusal path leaves no orphan `.safetensors` behind.

## Risks / non-goals
- There may already be colliding clones on disk in a live install — the fix must make them visible or removable, not merely prevent new ones.
- Non-goal: changing `_slug`, renaming built-ins, or making the built-in list configurable.

## Build record
Builder L1. **Resolution chosen: refuse new collisions, and let an already-on-disk clone win** — both halves, because either alone is insufficient. `voices.reject_builtin_collision(cid, name)` raises 409 naming the built-in, called by `create_voice` right after `_slug` (before any file or subprocess work, so a refusal leaves no orphan) and by `import_pack` before the zip is read; `rename=` remains the import escape hatch. And `_build_characters` now SKIPS the built-in when a cloned Character already owns the id, instead of clobbering it — because refusing new collisions does nothing for a live install that already has one, and that user needs the Character in the roster in order to delete it. Deleting it brings the built-in back, which is tested.

**Director review**: read both halves. The reasoning for refusing rather than letting new clones shadow is right — it keeps the premade roster intact and is the honest answer, since the id really is taken. The second half is the part a less careful builder would have skipped, and the acceptance criterion that demanded it ("a user who ALREADY has a colliding clone can still see and delete it") is exactly what made the difference. Tests cover create/import refusal with no file left, `rename` working, a seeded legacy `mary` clone visible + deletable + the built-in returning afterwards, and all other built-ins still present. All new tests patch `_META_LOCK_PATH` as well as `VOICES_DIR`/`META_PATH`, so unlike two older registry test files they do not write into the repo's real `voices/` dir. Gates on main: **487 passed, 81 subtests**. MERGED.

**Residual the builder flagged and correctly did not self-scope**: `ingest.commit` slugs the character name itself and does not call `reject_builtin_collision`, so the ingest path can still create a colliding character — though `_build_characters` now degrades that case gracefully (the clone stays visible and deletable rather than vanishing), so it is safe rather than silent. Handed to L3, which owns the ingest uniqueness check.

Also flagged: a 2-line excursion into `service/ingest.py` (import + `dst` via `voice_file_path`), required by direction 1's "every write asserts its resolved destination" criterion and cited in its evidence. Accepted; no builder in the lane owned that file.
