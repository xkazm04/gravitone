# Gravitone — harness learnings

Structural facts discovered during the 2026-07-14 dual-lens scan + fix campaign.
Read this before the next Phase 4.1 to avoid re-discovering them.

## Structural facts

- **2026-07-14** — Monorepo layout: `service/` (Python FastAPI TTS) + `web/` (Next.js 16 studio) + `deploy/`, all under `C:/Users/mkdol/dolla/arm/gravitone` (the git repo, branch `main`). The Vibeman project *path* is the parent `C:/Users/mkdol/dolla/arm`.
- **2026-07-14** — The Vibeman context map is stale: it uses pre-subtree-merge `gravitone-web/…` paths (real files are under `web/…`) and covers only 78 of 136 source files. Remap `gravitone-web/X` → `web/X` and add ad-hoc units for the uncovered service modules (`auth`, `certify`, `demand`, `export_stems`, `packs`, `replicas`, `takes`), the 14 `service/tests/` files, and ~37 `web/` files before any scan. **Refresh the map** (`update_context`) when convenient.
- **2026-07-14** — `mutate_meta(fn)` in `service/voices.py` runs `fn` under `_META_LOCK`; use it for any read-modify-write of the voice registry, and re-check invariants *inside* `fn` (see `import_pack` / the create_voice fix).
- **2026-07-14** — Cross-process atomic "first writer wins" over the filesystem = an `os.open(path, O_CREAT|O_EXCL|O_WRONLY)` sentinel (see `takes.pick_take`). The service runs N replica *processes* (`replicas.py`), so a `threading.Lock` alone is not enough for shared-file state (`api_keys.json`, `emotion_demand.json`, review picks).
- **2026-07-14 (CORRECTION)** — `voices._save_meta` was **already atomic** (mkstemp → write → `os.replace`, with `except BaseException: os.unlink(tmp)`) — an earlier note claiming the registry used a plain `write_text` was wrong. The gap was that its crash path was never *tested*; `test_registry_atomic` now injects a failure inside `_save_meta`. `service/atomicio.py::atomic_write_text` (added for `keys.py`/`demand.py`) is the same pattern for the other single-file stores; `takes.py` still uses plain `write_text` and is the remaining adoption candidate.

## Conventions enforced

- **2026-07-14** — Security controls fail *closed* when a secret is configured: an unsigned/signature-stripped cert or pack is rejected when `GRAVITONE_CERT_SECRET`/`TTS_PACK_SECRET` is set (only open when no secret). Compare secrets with `secrets.compare_digest`.
- **2026-07-14** — `backendFetch` (`web/lib/backend.ts`) attaches the root key; read paths use `READ_TIMEOUT_MS`, synthesis relays cap the body via `readCappedText`. Write paths set their own longer `AbortSignal`.

## Anti-patterns to avoid

- **2026-07-14** — Don't drain only one of a subprocess's two `PIPE`s across a long-lived child (torch load floods stderr → deadlock). Drain the other on a thread or merge streams.
- **2026-07-14** — Don't set a one-shot idempotency latch before its guarded work (a no-op run consumes the shot). Don't optimistically mutate UI without a snapshot+rollback. Don't claim a write succeeded without checking `r.ok`.

## Testing / environment

- **2026-07-14 (CORRECTED)** — **The whole service suite DOES run on this Windows box** — 163 tests across all 17 `service/tests/*` modules, no torch needed. `service/tests/fake_engine.py` installs dependency shims (a fake `pocket_tts`/`scipy`) on import, and every suite imports it early, so `app.py`/`engine.py`/`voices.py` load fine *under test*. (Importing them OUTSIDE the test harness still fails — that's why ad-hoc `python -c "import service.app"` breaks.) Run: `python -m unittest service.tests.<mod>`. `pytest` is not installed.
- **2026-07-14** — ⚠ **Run the FULL suite before calling a wave green, not a subset.** Wave 4 added `timeout=60` to `wav_bytes_to_mp3` and broke two `test_compat` stubs (rigid `fake_run(cmd, input, stdout, stderr)` → `TypeError` on the new kwarg). Only `test_ingest_*`/`test_replicas` were re-run, so the wave was reported green while `test_compat` was red for 4 waves. Loop all 17 modules.
- **2026-07-14** — Test doubles should mirror the real callee's tolerance (`**kw` on a `subprocess.run` stub), or a legitimate source-side kwarg addition manufactures a fake test failure.
- **2026-07-14** — Test output with non-ASCII needs `PYTHONIOENCODING=utf-8` on Windows (cp1252 console).

## Repo gotchas

- **2026-07-14** — `.gitignore` has `takes/` and `reviews/` (runtime data dirs) which ALSO match the tracked route dir `web/app/api/takes/`. `git add web/app/api/takes/...` prints an "ignored" hint and **exits non-zero** even though the files are tracked, breaking `git add … && git commit` chains. Stage those paths in a separate `git add` (they still stage) or use `-f`.

## Open follow-ups (from the 2026-07-14 campaign)

- **Ingest commit/GC lifecycle** (svc-ingest-pipeline #2/#3/#4): partial-commit orphans consent voices; GC deletes stems mid-review (age-not-idleness); empty-plan commit reports success. Deferred — need rollback/status design + Linux testing.
- **keys.py event-loop caching** (svc-synthesis-api #1): every managed-key request does a sync file read+parse on the asyncio loop under a global lock. Fix = mtime-cached parse + `run_in_executor`; deferred to a perf pass (multi-process cache-coherency care needed).
- **Deferred from earlier waves**: web privileged-write proxy auth model (firebase-admin session gate vs same-origin/CSRF); memory-only API secret (removes copy-later UX); the service-side consent finding for streaming errors swallowed (`app.py`). See `followups-2026-07-10.md` for the pre-campaign backlog.

## Structural facts (moonshot campaign, 2026-07-30)
- **2026-07-30** — Engine dispatch seam: `service/engines.py` is the capability registry + resolver; `convai._resolve_voice` is a re-export. New engines = adapter + `engine_conformance.py` pass.
- **2026-07-30** — `service/app.py` synthesis core is `_render_tts` (shared by the drop-in and with-timestamps routes); request identity is `buildstore.speech_digest` under the DIGEST LAW (any identity-affecting change must bump a version component — golden digests pin it).
- **2026-07-30** — Dialog brains emit `TurnPart` (a str subclass) — every legacy consumer works on plain strings; directives `[lang:]/[emotion:]/[end_call]` are stripped on the raw tail so no stream chunking can leak them.
- **2026-07-30** — Web token system: `tokens.ts` → `<GravitoneTokens>` → `--gt-*` CSS vars; AudioBus writes live signal vars on ONE scoped node. `web/lib/serviceHeaders.ts` must mirror `app.py::CORS_EXPOSE_HEADERS` — its drift test caught new headers in 4 separate batches; adding a header in app.py is a TWO-file change.
- **2026-07-30** — Registry rows now carry `fidelity`, `prosody`, `origin`("recorded"|"derived"), `derived_from`; `voices/_basis.safetensors` must stay excluded from the roster glob (phantom-Character hazard).
- **2026-07-30** — Ingest job results carry per-segment `i`/`ok`/outlier + `casting` board + audition `recipes`; editing stems WITHDRAWS audition recipes (coherence invariant, tested).
- **2026-07-30** — replicas.py children spawn via `--child` (admin thread + uvicorn); service imports must stay lazy child-only — an AST test pins top-level imports.

## Conventions enforced (added 2026-07-30)
- Parallel-builder batches: per-batch DESIGN doc with exact contracts + single-owner file matrix; hot files have ONE owner; cross-owner changes ship as exact patches applied by the orchestrator; builders never run git.
- Ship-gate = full per-module unittest loop (subprocess per module) + full web tsc/vitest/next-build. A wave is never green on a subset.
- Measured facts UX: named facts not scores; "identity match" never "quality"; absent renders nothing; advisory never blocking; refusals named verbatim.

## Anti-patterns to avoid (added 2026-07-30)
- Believing a builder's "green" without the orchestrator's own full loop (transient cross-file failures during parallel flight are normal; the FINAL loop is the truth).
- Letting FastAPI auto-bind new function params on routed handlers — `fidelity_identity` became a spoofable query param; keyword-only + a schema-pinning test is the pattern.
- Cache keyspace mixing: alignments live in a sibling ALIGN_CACHE, never inside SYNTH_CACHE (cache.py's stated law).

## Open follow-ups (from moonshot campaign, 2026-07-30)
- Firestore rules for speakers/** (batch3/REPORT-SIGN-OFF.md) — USER action, blocks real two-party consent.
- Arm-box session: sealed image build + sealed.yml run + license review; emotion_residuals go/no-go; real loadtest→certify→plan→ledger cycle.
- aws/run_benchmark.sh fetch step (perf-ledger matrix appends are inert without it, fail loudly).
- Public re-perform + hero-demo shared per-IP rate limiter; /v1/narrate + narrate.js embed; gravitone.lock client; utterance fan-out; local browser engine (quarters); algebra autofill/blending/pack-origin travel.
- PlaygroundConsole "keyed backend/unkeyed studio" test remains load-flaky (green standalone; predates campaign) — stabilization candidate.
