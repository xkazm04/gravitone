---
slug: registry-write-invariants
type: perfect/direction
context: "[[Voice & Emotion Library]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 054a791
---
## What & why
The registry's own write routes bypass the invariants the rest of the module enforces. `PATCH /v1/voices/{id}` sets the emotion with a bare `.strip().lower()` — no normalization, no duplicate-slot check — so two voices of one character can occupy the same emotion, after which `emotion_map` silently drops one (dict collision) while `coverage` counts the set: the roster and the synthesis map disagree about what exists. It is also the only path that can put a space- or dot-bearing emotion into the registry, which the metatag grammar can then never address. And `PATCH /v1/characters/{id}` will rename a BUILT-IN and create a registry row for a character that has no voices, while three sibling routes correctly refuse built-ins.

## Evidence
- `service/voices.py:653-654` — `entry["emotion"] = patch.emotion.strip().lower()`; no `normalize_emotion` (`emotions.py:52`), no uniqueness check, no custom-slot registration (`character_scale`, `voices.py:305-316`).
- `service/voices.py:398` — `emotion_map` builds a dict keyed on emotion, so a duplicate silently drops one voice; `:370` — `coverage` counts `set(emotions)`.
- `service/voices.py:656-659` — `PATCH` writes `entry["name"]`, but every read derives the display name from the CHARACTER row (`:295-298`) and the response returns `cname` — the API reports a change it did not make. The only consumer of a voice-level `name` is the legacy migration (`:157`).
- `service/voices.py:725` — `patch_character` `setdefault`s a row for ANY id, including a built-in; contrast `add_custom_emotion` (`:424`), `delete_voice` (`:717`) and `delete_character` (`:740`), which all refuse built-ins explicitly.
- `service/ingest.py:1390-1392` — the ingest commit registers voices without a `(character_id, emotion)` uniqueness check either; only `create_voice` (`:617-621`) and `import_pack` (`packs.py:194-195`) re-check under the lock.
- Zero tests exist for `PATCH /v1/voices`, `PATCH /v1/characters`, `DELETE /v1/voices`, `DELETE /v1/characters`, `GET /v1/emotions`, the custom-emotion routes, or `GET /v1/characters/{id}/manifest`.

## Acceptance criteria
- Every mutation normalizes its emotion through `normalize_emotion`, so the registry cannot hold an emotion the metatag grammar cannot address.
- `(character_id, emotion)` uniqueness is enforced on EVERY write path, not two of five — including the ingest commit.
- Built-in protection is consistent across all four mutating character/voice routes.
- `PATCH /v1/voices`'s `name` either works end to end or is removed from the API; it must not keep reporting a change it did not make.
- The previously untested routes get tests — at minimum the invariant each one was violating.

## Risks / non-goals
- Enforcing uniqueness may reject writes that currently succeed; that is the point, but the error must say which existing voice holds the slot.
- Non-goal: redesigning the emotion scale, or adding a rename/merge flow for voices that already collide.

## Build record
Builder L3 (a first attempt stalled during exploration having written nothing; the worktree was clean, so there was nothing to recover and a fresh builder was briefed with the orientation summarised inline). New `slot_holder` / `reject_slot_collision` / `_by_emotion` in `voices.py`; `patch_voice` rewritten; `patch_character` guarded; `remove_custom_emotion` normalized; `create_voice`'s two checks now name the holder and reuse the shared one. `ingest.commit` calls `reject_builtin_collision` for new characters before any work, skips planned emotions whose slot is already held (reported like the too-short-stem skip), and re-checks under the registry lock — unlinking the embedding it would otherwise have orphaned, because the roster is glob-driven.

**`PATCH /v1/voices`'s `name` was REMOVED, not fixed** — nothing reads a voice-level name except the legacy `_load_meta` migration, and the response derived the name from the character row anyway. `extra="forbid"` means an old client gets a 422 rather than a silent no-op. The builder checked there was no web caller first (`web/app/voices/_data/characters.ts` only patches characters).

**Pre-existing duplicate rows — chosen behaviour: tolerate and converge, never drop.** Both voices stay in the roster, because a Voice that is invisible is also undeletable — the same reasoning as the built-in collision rule, applied consistently. `coverage` still counts distinct emotions so the count stays honest, and the new `_by_emotion` makes `emotion_map` and the manifest pick the SAME voice (first in scale order) with a warning naming both ids. **This uncovered a real bug beyond the brief**: the manifest's dict comprehension let the LAST duplicate win while `emotion_map` took the FIRST — the two disagreed about which voice actually speaks. A test proves the loser can be deleted to resolve the duplicate.

**Anti-vacuous, six reverts in isolation, all producing the expected failures**: patch_voice enforcement → 3; patch_character guard → 2; `VoicePatch.name` restored → 1; ingest built-in guard → 1; ingest slot skip → 1; `_by_emotion` in the manifest → 1. The builder also found and fixed a flake of its own making: `next(iter(BUILTIN_IDS))` made the ingest-collision test hash-order dependent (`bill_boerst` slugs to a different id), now pinned to `mary`.

**Director review**: gates on main — compileall clean, **540 passed, 87 subtests** (509 before, 469 at round start). MERGED.
