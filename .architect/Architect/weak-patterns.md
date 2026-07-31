# Weak Patterns

Anti-patterns identified by `/architect`, with reach data. Each entry should
eventually convert into a backlog decision (or get explicitly accepted as
"tolerable for now" with a reason).

## Patterns

## Rigorous core, unapplied at the edges  ← the repo's signature weakness

- First seen: 2026-07-26 (run 1, error handling) / Last seen: 2026-07-26 (run 2, async patterns)
- Reach trend: **recurring** — found twice in two scans, in different themes
- Shape: a module is engineered carefully (engine.py's job lifecycle; app.py's
  sanitized errors and executor offloads; takes.py's O_EXCL sentinel), and then
  callers clone half of it. Run 1: the proxy layer fragmenting a clean service
  error contract. Run 2: speak/performance cloning submit-all-then-gather
  without the abandon half; GC cloning teardown without the cancel flag;
  voices.py using a thread lock where takes.py proved a file lock was needed.
- Mitigation now in place: three CLAUDE.md convention sections + two guard
  tests (`test_handler_modes.py`, `test_file_lock.py`).
- **Scan heuristic**: on any future theme, find the best-implemented module and
  audit its partial imitators first.

## Proxy error-dialect fragmentation

- First seen: 2026-07-26 / **FIXED same run** (commit 21dab69)
- Reach at detection: 26 routes / 5 dialects; now 1 (`proxyJson`)
- ADR: [[Architect/decisions/2026-07-26-proxy-contract]]

## Silent failure swallows (UI + service)

- First seen: 2026-07-26 — 6 UI sites + streaming swallow fixed in run 1; 5 more web holes fixed in run 2 (b92ae3f)
- Residual: auto-clearing surfaces (2s pip/label) can still vanish unseen — accepted for now.
- ADRs: [[2026-07-26-silent-failures]], [[2026-07-26-stream-swallow]], [[2026-07-26-web-critical-async]]

## Blocking work on the event loop

- First seen: 2026-07-26 (run 2) / **FIXED same run** (fb0743e)
- Reach at detection: 4 upload handlers + 2 auth deps + 5 hot-path call sites
- Reach trend: eliminated; guarded by `test_handler_modes.py`
- ADR: [[Architect/decisions/2026-07-26-loop-blocking]]

## Per-process locks under a multi-process topology

- First seen: 2026-07-26 (run 2) / **FIXED for the registry** (3b183f2)
- Residual: `demand.py` (`emotion_demand.json`) still uses a thread lock across replicas — accepted: advisory telemetry, a lost increment doesn't affect correctness. Revisit if demand data ever drives behavior.
- ADR: [[Architect/decisions/2026-07-26-cross-process-registry]]

## Partial-write teardown (commit interrupted mid-clone)

- First seen: 2026-07-26 (run 2) / **cancel path FIXED** run 3 (4413dda)
- Shape: `ingest.commit` registers each emotion as it completes, so any
  interruption after the first one leaves a partial Character in `VOICES_DIR`
  while the workdir teardown cleans nothing there.
- Cancel (DELETE / GC): now rolled back via `voices.remove_voices`.
- **Residual: the ERROR path.** A commit that raises mid-way still leaves what
  succeeded — `commit()` raises without returning `created`, so the ids aren't
  available to undo. Queued; decide the semantics before implementing.
- ADRs: [[2026-07-26-ingest-teardown]], [[2026-07-26-cancelled-commit-rollback]]

## Remaining known gaps (queued or accepted)

Queued in `backlog.md`: error-path commit rollback; wider web test coverage;
the pre-existing npm advisories in next/postcss/sharp.
**Closed in run 3**: cancelled-commit rollback, client AbortController,
engine.ts 5xx-vs-unreachable copy, and the missing web test runner — the
"no structural guard possible for web" gap is gone.

Accepted for now:
- `keys.py`/routers use positional HTTPException vs app.py keyword style — cosmetic.
- `keys.list_keys` reads without `_STORE_LOCK` — read-only, worst case a stale `last_used`.
- `takes.py::_evict_oldest` check-then-act — bounded store, over-eviction is harmless.
- `_gc_loop` still swallows sweep exceptions, but now logs them.
