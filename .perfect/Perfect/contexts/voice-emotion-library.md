---
name: Voice & Emotion Library
type: perfect/context
group: TTS Service Core
category: lib
opportunity: 8
last_proposed: 2026-07-28 (round 7)
cooldown_until: round 9
directions: ["[[nearest-emotion-fallback]]", "[[atomic-voice-registry]]", "[[registry-read-cache]]", "[[one-emotion-grammar]]", "[[pack-import-path-safety]]", "[[builtin-name-collision]]", "[[registry-never-silently-empty]]", "[[registry-write-invariants]]", "[[one-exporter-clone-path]]"]
---
## Current state (scouted 2026-07-28, round 7)
Score raised 7 → 8: the scout found genuine DEFECTS here, not gaps.

Registry is `voices/_meta.json` = `{"voices": {...}, "characters": {...}}`, but **existence is filesystem-driven, not registry-driven**: `_cloned_voices` globs `*.safetensors` and looks meta up per stem (`voices.py:291-301`), so meta only DECORATES. An orphan file becomes a phantom Character; an orphan row is invisible. Two categories only: `cloned` (any file) and `premade` (26 hard-coded `BUILTIN`). `Character` is derived, not stored (`voices.py:69-88`).

Every write funnels through `mutate_meta` (`voices.py:218-242`) = `_META_LOCK` (RLock) + cross-process `file_lock` + mkstemp/`os.replace` + cache-generation bump. That part is genuinely solid and well tested. Cross-process cache invalidation works **incidentally**: `file_lock` creates and deletes `._meta.lock` INSIDE `VOICES_DIR`, bumping the dir mtime that `_registry_fingerprint` reads — nothing names this dependency, and removing the lock-file unlink would silently break it.

Emotions: `EMOTION_SCALE` (8 slots), `normalize_emotion` (`^[a-z][a-z0-9_]{1,23}$`), metatag grammar `parse_segments`, `FALLBACK_CHAIN` (7 one-hop entries), `resolve()` = exact → neighbour → `deterministic_fallback`. The manifest shares `deterministic_fallback` with synthesis so it cannot advertise a pick synthesis would not make — and a test asserts the FUNCTION IDENTITY, not just agreement. Good design worth preserving.

Rough (Director-verified where load-bearing):
- **Pack import can write outside `VOICES_DIR`** — `emotion` from an untrusted manifest with only `.strip().lower()` interpolated into a filename (`packs.py:197-199`). Director confirmed `../../../../tmp/evil` escapes with pack-controlled bytes; signing is off by default. → [[pack-import-path-safety]]
- **A cloned character colliding with a BUILTIN id is silently erased** — the built-in loop clobbers `chars[vid]` after the cloned assembly (`voices.py:353-360`), and `BUILTIN` is a list of ordinary first names. → [[builtin-name-collision]]
- **A corrupt `_meta.json` empties the roster and the next write persists that emptiness** (`voices.py:148-149`); orphan files and registry-only ghosts are not convergeable through the API. → [[registry-never-silently-empty]]
- **`PATCH` routes bypass their own invariants** — no `normalize_emotion`, no `(character_id, emotion)` uniqueness, built-ins renameable, and a `name` field that is written but never read while the response reports the change. → [[registry-write-invariants]]
- **Two export mechanisms** — `POST /v1/voices` still spawns the CLI with no load-back verification, unlike `export_stems`. Round 1's `one-true-clone-path` shipped as a shared FILTER only. → [[one-exporter-clone-path]]
- Not taken: `/v1/voices/{id}`'s 404 puts a dict in `detail` (`voices.py:490`) contradicting `errors.py`'s one-voice contract — but ElevenLabs' own shape IS structured, so the honest fix is to decide which contract wins and state it; `voices.invalidate()` has no production caller; `_cache_generation` is read/written outside `_CACHE_LOCK` (benign under the GIL, but not the invariant the comments claim); five different phrasings of "character not found" while `get_character_or_404` exists to end exactly that drift and `app.py` never calls it; `_demand_cache` has no invalidation hook (2s TTL, documented); `_registry_fingerprint` is stat-only; **two registry test files lock the REAL repo `voices/` dir** because they patch `VOICES_DIR` but not the import-bound `_META_LOCK_PATH`.
- **The read-cache aliasing hazard is LATENT, not live**: `list_characters()` returns the same mutable object to every caller (`voices.py:330`) and a test asserts that sharing as intended (`test_registry_cache.py:81`) — but the scout traced every caller and none mutates today. Recorded, not proposed.

## Direction history
2026-07-13 — proposed 5: nearest-emotion-fallback ✅ atomic-voice-registry ✅ registry-read-cache ✅ one-emotion-grammar ❌ (+1 other ❌).
2026-07-28 (round 7) — proposed 5, **all 5 accepted**: pack-import-path-safety ✅ builtin-name-collision ✅ registry-never-silently-empty ✅ registry-write-invariants ✅ one-exporter-clone-path ✅. Slate deliberately skewed to correctness (4 robustness + 1 consolidation wildcard, no feature/ux entry) because the scout surfaced defects rather than gaps; stated as such at the gate and accepted in full.

## Shipped
Round 2: nearest-emotion-fallback → 0537289 · atomic-voice-registry → 42f1bb9 (+9fa3390 Director) · registry-read-cache → 4ab9b8c

Round 7 (2026-07-28) — 5/5:
- [[pack-import-path-safety]] → **2d16fd5** — untrusted manifest strings now go through `normalize_emotion` (reject, never sanitise) and every write asserts containment via the new `voice_file_path`. Director re-verified the exploit is closed at both layers.
- [[builtin-name-collision]] → **d329aec** — new collisions refused with a 409 naming the built-in; an ALREADY-colliding clone now wins the roster so it can be seen and deleted.
- [[registry-never-silently-empty]] → **401a12a** — a corrupt `_meta.json` raises 503 and is left byte-identical; `create_voice` stages into temp and moves after the commit; one deletion ordering (`_unlink_then_forget`) for all three paths.
- [[one-exporter-clone-path]] → **3707fb4** — the direct clone uses the load-back-verified batch exporter; `voices.py` no longer spawns the CLI at all.
- [[registry-write-invariants]] → **054a791** — normalization + `(character_id, emotion)` uniqueness on all five write paths, consistent built-in protection incl. the ingest boundary, `VoicePatch.name` removed, and `_by_emotion` making the manifest and `emotion_map` agree.

**Observed effect**: 469 → 540 service tests across the round, and seven previously untested routes gained coverage.
