# Dual-lens scan — svc-voice-emotion-lib
> Files: 3 | Findings: 5 (crit 0 / high 3 / med 2 / low 0)
> Lenses: bug-hunter + code-refactor

## 1. create_voice never re-checks the emotion slot under the registry lock
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: race-condition (TOCTOU)
- **File**: `service/voices.py:552`
- **Scenario**: Two `POST /v1/voices` requests for the same `character=alba, emotion=happy` arrive close together. Both pass the `if emotion in emotion_map(cid)` check at line 552 (nothing is committed yet), both spend seconds in the `pocket_tts export-voice` subprocess, then both run `mutate_meta(_commit)` at line 604 — which writes to a fresh uuid voice_id and does NOT re-verify the emotion is still free.
- **Root cause**: The duplicate-emotion guard is a pre-subprocess fast check, but `_commit` (lines 585–604) has no re-check inside `_META_LOCK`. The heavy subprocess makes the check→commit window very wide. Contrast `import_pack`, which deliberately re-checks the character id under the lock (`packs.py:176`).
- **Impact**: A Character ends up with two Voices for the same emotion. `emotion_map` (`{v.emotion: v.voice_id …}`, line 366) keeps only one, so the other `.safetensors` embedding is orphaned/unaddressable, and `coverage`/`emotions` double-count the slot.
- **Fix sketch**: Move the `emotion in emotion_map`-equivalent check inside `_commit`, re-derived from `meta["voices"]` under the lock (mirror the `import_pack` re-check at `packs.py:176`); raise 409 there.

## 2. Unsigned packs bypass authenticity even when TTS_PACK_SECRET is set
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: trust-boundary / signature-stripping
- **File**: `service/packs.py:138`
- **Scenario**: An operator sets `TTS_PACK_SECRET` specifically to only accept trusted packs. An attacker crafts a `.gravichar` with malicious embeddings and simply omits the `signature` key. `if PACK_SECRET and sig:` is False, so the HMAC verification block is skipped and the pack imports.
- **Root cause**: Verification is gated on the signature being *present* rather than *required*. The check only rejects a *mismatched* signature; a *missing* signature is treated as "nothing to verify" — a classic downgrade path.
- **Impact**: The authenticity control is trivially defeated by stripping the field, so a shared-secret deployment provides no real protection against untrusted packs.
- **Fix sketch**: When `PACK_SECRET` is set, fail closed: reject any pack lacking a valid signature (`if PACK_SECRET and not (sig and hmac.compare_digest(...))`). Keep unsigned packs allowed only when no secret is configured.

## 3. import_pack decompresses each voice fully before the size check (zip bomb)
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: resource-exhaustion / DoS
- **File**: `service/packs.py:161`
- **Scenario**: A crafted pack uses `ZIP_DEFLATE` with a member whose uncompressed size is multiple GB (a small compressed blob). `data = z.read(arcname)` at line 161 decompresses the entire member into RAM, and only line 164 (`len(data) > MAX_VOICE_BYTES`) checks size — after the allocation. With up to `MAX_VOICES=64` members staged in memory (`staged`, plus the whole uploaded zip from `await file.read()`), a single request can OOM-kill the service.
- **Root cause**: Size enforcement happens post-decompression instead of against the ZIP directory's declared `file_size`, and all members are buffered simultaneously.
- **Impact**: One anonymous upload to the import endpoint can crash the synthesis service (memory exhaustion), taking down TTS for all clients.
- **Fix sketch**: Before `z.read`, consult `z.getinfo(arcname).file_size` and reject if it exceeds `MAX_VOICE_BYTES`; also bound the total across members. Optionally stream to disk with a running byte cap instead of buffering all of `staged` in RAM.

## 4. Custom emotions with digits are unaddressable via metatags and leak markup into speech
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: input-grammar-mismatch / silent-malfunction
- **File**: `service/emotions.py:64`
- **Scenario**: `normalize_emotion` (`_EMOTION_RE`, line 49) accepts digits (`^[a-z][a-z0-9_]{1,23}$`), so `add_custom_emotion`/`create_voice` happily register an emotion like `robot2`. A user then writes `[robot2]beep boop[/robot2]` in `POST /v1/speak`. `_TAG_RE` (line 64) matches only `[a-zA-Z_]*` for the tag name, so `[robot2]` fails to match as a tag entirely.
- **Root cause**: Two grammars for the same concept diverge — the emotion-name validator allows digits, but the metatag parser's name class excludes them.
- **Impact**: The valid custom emotion can never be reached through the metatag path; worse, the literal `[robot2]…[/robot2]` markup passes through `parse_segments` as ordinary text and is spoken aloud verbatim.
- **Fix sketch**: Align the two: either forbid digits in `normalize_emotion` (drop `0-9`), or widen `_TAG_RE`'s name class to `[a-zA-Z0-9_]*` so any normalized emotion is tag-addressable.

## 5. "Find character by id" scan duplicated across ~8 call sites
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `service/voices.py:364`
- **Scenario**: The pattern "iterate `list_characters()` and return the one whose `character_id` matches (else 404/None)" is hand-rolled in `emotion_map` (364), `get_scale` (376), `add_custom_emotion` return (406), `get_character` (443), `character_manifest` (497), `patch_character` return (648), and in `packs.py` `export_pack` (61) and `import_pack` (196).
- **Root cause**: No shared lookup helper over the assembled roster, so every endpoint re-implements the linear scan and its not-found handling.
- **Impact**: Eight copies to keep in sync; a change to lookup semantics (e.g. case-folding ids, or adding an index) must be made in eight places, and the 404 message/shape already drifts between sites.
- **Fix sketch**: Add `find_character(character_id) -> Character | None` (and/or `get_character_or_404`) in `voices.py`, backed by `list_characters()`, and replace all eight scans — importing it into `packs.py` alongside the existing `list_characters` import.
