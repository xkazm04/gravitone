# Gravitone — harness learnings

Structural facts discovered during the 2026-07-14 dual-lens scan + fix campaign.
Read this before the next Phase 4.1 to avoid re-discovering them.

## Structural facts

- **2026-07-14** — Monorepo layout: `service/` (Python FastAPI TTS) + `web/` (Next.js 16 studio) + `deploy/`, all under `C:/Users/mkdol/dolla/arm/gravitone` (the git repo, branch `main`). The Vibeman project *path* is the parent `C:/Users/mkdol/dolla/arm`.
- **2026-07-14** — The Vibeman context map is stale: it uses pre-subtree-merge `gravitone-web/…` paths (real files are under `web/…`) and covers only 78 of 136 source files. Remap `gravitone-web/X` → `web/X` and add ad-hoc units for the uncovered service modules (`auth`, `certify`, `demand`, `export_stems`, `packs`, `replicas`, `takes`), the 14 `service/tests/` files, and ~37 `web/` files before any scan. **Refresh the map** (`update_context`) when convenient.
- **2026-07-14** — `mutate_meta(fn)` in `service/voices.py` runs `fn` under `_META_LOCK`; use it for any read-modify-write of the voice registry, and re-check invariants *inside* `fn` (see `import_pack` / the create_voice fix).
- **2026-07-14** — Cross-process atomic "first writer wins" over the filesystem = an `os.open(path, O_CREAT|O_EXCL|O_WRONLY)` sentinel (see `takes.pick_take`). The service runs N replica *processes* (`replicas.py`), so a `threading.Lock` alone is not enough for shared-file state (`api_keys.json`, `emotion_demand.json`, review picks).

## Conventions enforced

- **2026-07-14** — Security controls fail *closed* when a secret is configured: an unsigned/signature-stripped cert or pack is rejected when `GRAVITONE_CERT_SECRET`/`TTS_PACK_SECRET` is set (only open when no secret). Compare secrets with `secrets.compare_digest`.
- **2026-07-14** — `backendFetch` (`web/lib/backend.ts`) attaches the root key; read paths use `READ_TIMEOUT_MS`, synthesis relays cap the body via `readCappedText`. Write paths set their own longer `AbortSignal`.

## Anti-patterns to avoid

- **2026-07-14** — Don't drain only one of a subprocess's two `PIPE`s across a long-lived child (torch load floods stderr → deadlock). Drain the other on a thread or merge streams.
- **2026-07-14** — Don't set a one-shot idempotency latch before its guarded work (a no-op run consumes the shot). Don't optimistically mutate UI without a snapshot+rollback. Don't claim a write succeeded without checking `r.ok`.

## Testing / environment

- **2026-07-14** — **The Python service is NOT fully testable on this Windows box**: `torch` + `pocket-tts` are aarch64-Linux-only wheels, so any module that imports the engine (`app.py`, `engine.py`, `voices.py`, `ingest.py` transitively) can't be imported here. Gate service fixes with `python -m py_compile`, targeted smoke tests, and the unittest files that *don't* pull torch: `test_keys`, `test_replicas`, `test_ingest_lifecycle`, `test_ingest_pipeline` all run clean (they stub the engine/subprocess). Full pytest needs a Linux ARM box. `pytest` itself isn't installed — use `python -m unittest service.tests.<mod>`.
- **2026-07-14** — Test output with non-ASCII needs `PYTHONIOENCODING=utf-8` on Windows (cp1252 console).

## Repo gotchas

- **2026-07-14** — `.gitignore` has `takes/` and `reviews/` (runtime data dirs) which ALSO match the tracked route dir `web/app/api/takes/`. `git add web/app/api/takes/...` prints an "ignored" hint and **exits non-zero** even though the files are tracked, breaking `git add … && git commit` chains. Stage those paths in a separate `git add` (they still stage) or use `-f`.

## Open follow-ups (from the 2026-07-14 campaign)

- **Ingest commit/GC lifecycle** (svc-ingest-pipeline #2/#3/#4): partial-commit orphans consent voices; GC deletes stems mid-review (age-not-idleness); empty-plan commit reports success. Deferred — need rollback/status design + Linux testing.
- **keys.py event-loop caching** (svc-synthesis-api #1): every managed-key request does a sync file read+parse on the asyncio loop under a global lock. Fix = mtime-cached parse + `run_in_executor`; deferred to a perf pass (multi-process cache-coherency care needed).
- **Deferred from earlier waves**: web privileged-write proxy auth model (firebase-admin session gate vs same-origin/CSRF); memory-only API secret (removes copy-later UX); the service-side consent finding for streaming errors swallowed (`app.py`). See `followups-2026-07-10.md` for the pre-campaign backlog.
