---
slug: pack-import-path-safety
type: perfect/direction
context: "[[Voice & Emotion Library]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 2d16fd5
---
## What & why
A character pack is an untrusted file, and importing one can write outside the voices directory. `import_pack` takes `emotion` straight from the pack's own manifest with only `.strip().lower()` and interpolates it into a filename. The sha256 check is no defence — it validates the content against the SAME manifest — and pack signing is off by default, so a stock deployment accepts unsigned packs. A user importing a pack a collaborator sent them is the ordinary path here.

## Evidence
- `service/packs.py:197` — `emotion = str(v.get("emotion") or "baseline").strip().lower()`; `:198-199` — `voice_id = f"{cid}-{emotion}-{hex}"` then `(VOICES_DIR / f"{voice_id}.safetensors").write_bytes(data)`.
- **Director-verified escape**: an `emotion` of `../../../../tmp/evil` resolves to `…/arm/tmp/evil-abc123.safetensors` — outside `VOICES_DIR` — with the pack's bytes as content. (A URL-encoded `..%2f..%2f` does NOT escape, so the fix must target real separators and `..` segments, not a naive substring ban.)
- `service/packs.py:184` — the sha256 comparison is against the manifest's own digest.
- `service/packs.py:42` — `PACK_SECRET = os.environ.get("TTS_PACK_SECRET", "")`; `:140-148` — signature enforcement only when it is set.
- Same class, lower severity: `service/ingest_api.py:639` `CommitReq.emotions: list[str]` is client-supplied and flows unvalidated into `work_dir/f"stem_{emo}.wav"` and the destination path (`ingest.py:1309, 1318-1321`).
- `service/emotions.py:52-62` — `normalize_emotion` already exists and already enforces `^[a-z][a-z0-9_]{1,23}$`. Every safe write path uses it; these do not.

## Acceptance criteria
- Every emotion that reaches a filename or a registry row passes through `normalize_emotion` — the one function that defines what an emotion is — and a pack whose manifest fails it is rejected with a clear reason rather than sanitised into something else.
- Every write asserts its resolved destination is inside `VOICES_DIR` before writing, so a future path-building bug cannot escape either.
- The ingest `emotions` list is validated at the route boundary.
- Tests cover: `..` traversal, an absolute path, a URL-encoded attempt (which must be REJECTED as an invalid emotion, not silently accepted as a weird-but-contained name), and a legitimate custom emotion still importing cleanly.
- A pack that fails validation leaves nothing behind on disk.

## Risks / non-goals
- Do not make signing mandatory as the fix — that is a separate product decision and would break existing unsigned packs. Validate the input instead.
- Non-goal: redesigning the pack format, or the `TTS_PACK_SECRET` default.
- Reject rather than sanitise: silently rewriting a hostile emotion to something valid would import a voice under a name the sender chose and the receiver never sees.

## Build record
Builder L1. Every manifest string that reaches a filename or a registry row now goes through the existing `emotions.normalize_emotion` — the per-voice `emotion` AND the manifest's `custom_emotions` — and a failure is a **400 naming the offending value**, never a sanitisation. Validation runs entirely before `VOICES_DIR.mkdir` and before any write. New shared helper `voices.voice_file_path(voice_id, voices_dir=None)` resolves the destination and asserts its parent is the voices dir before returning it; used by `import_pack`, `create_voice` and ingest's export-plan `dst`. It takes the dir EXPLICITLY because `packs`/`ingest` bind their own `VOICES_DIR` at import — a helper reading `voices.VOICES_DIR` would have silently ignored a test's patch, which is a nice catch. `import_pack`'s file loop unlinks what it wrote if anything raises, so a refused import leaves nothing behind.

Builder went one field further than briefed, correctly: `CommitReq.character_id` is the same client-supplied-into-a-path hole one field over, so it validated that too (`!= _slug(character_id)` → 400), both checks before `_admit()`.

**Director review**: this was the round's most consequential diff and I verified BOTH layers against the exploit I had demonstrated at propose time, running the merged code directly:
- `normalize_emotion`: `'../../../../tmp/evil'` → REJECTED, `'..%2f..%2fx'` → REJECTED, `'/abs/path'` → REJECTED, while `'Battle Cry'` → `'battle_cry'` and `'battle_cry'` passes. So hostile input is refused, not quietly contained, and legitimate custom emotions still work.
- `voice_file_path`: `'ada-../../../../tmp/evil-abc'` → REFUSED, `'../escape'` → REFUSED, `'ada-happy-abc'` → allowed. The containment check compares `path.resolve().parent != base.resolve()` rather than a `startswith` prefix — correct, since a prefix test would accept a sibling `voices-evil/` directory.
Gates on main: compileall clean, **487 passed, 81 subtests** (469 at round start). MERGED.
