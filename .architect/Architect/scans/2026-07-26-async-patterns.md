---
date: 2026-07-26
mode: scan
theme: async-patterns
sub_agents_spawned: 4
findings_total: 8
findings_weak: 3
findings_strong: 1
findings_swap: 0
findings_struct_bug: 3
findings_convention_gap: 1
executed: [1, 2, 3, 4, 5, 6, 7, S8]
queued: []
dropped: []
reworked: []
adrs_written: ["abandon-protocol", "loop-blocking", "ingest-teardown", "cross-process-registry", "deploy-durability", "web-critical-async", "web-async-hygiene", "codify-cross-process-sentinel"]
commits: [4c20acf, fb0743e, 13db576, 3b183f2, 4aa0be3, b92ae3f, 2b318a5]
branch: "(committed to main)"
---

# Architect scan — async-patterns (2026-07-26)

Second run of the day (error-handling ran first; its backlog was empty, so
resume fell through to a fresh scan). Theme picked from `coverage.md` as the
biggest unswept cross-cutting surface.

**Thesis: the engine's concurrency rigor stops at `engine.py`'s edge.** All
four angles independently praised the worker pool (permits, drain ordering,
futures, metrics locking) and all four found the same class of defect *outside*
it — the pattern was admired rather than applied.

## Sub-agent reports (summaries)
- **Thread↔asyncio boundary** (smell 4): 7 spawn sites, 5 unordered locks;
  gather-siblings never abandoned; GC teardown skips the cancel flag and
  `_persist` resurrects the reaped workdir; blocking locks/subprocesses
  acquired on the loop in 5 modules. Praised the re-check-under-lock family as
  consistently correct.
- **Lifecycle & cancellation** (smell 3): ingest threads have no shutdown
  participation; a cancelled commit leaves registered voices and discards the
  list; the durability design is inert in the shipped deploy (unmounted
  workdir) and defeated by the topology (per-process JOBS × SO_REUSEPORT);
  import-time thread start; three uncoordinated timeouts.
- **Web async hygiene** (smell 2–3): alive-guard coverage ~40%, all four data
  hooks unguarded; key rotate has no in-flight gate; `recordVoiceOwnership`
  result dropped 2 of 3; object-URL leak in the preview hook; zero client
  AbortControllers; nine leaky toast timers with one correct implementation.
- **Event-loop blocking** (smell 4): five `async def` upload handlers doing
  subprocess/50-200MB work on the loop (worst: clone's model load freezing all
  synthesis); auth deps parsing the key store per request; `concat_wavs` inline
  next to an executor-offloaded sibling; per-segment `record_fallback` writes.

## Findings & verdicts
All eight executed this session (user: "Execute all 8"). Seven commits, one
per decision, each gated. Service suite 194 → 209 tests; tsc clean throughout.

| # | Title | Commit |
|---|---|---|
| 2 | Abandon protocol on batch routes (+ client disconnect) | 4c20acf |
| 1 | Blocking work off the event loop | fb0743e |
| 3 | One teardown protocol for ingest jobs | 13db576 |
| 5 | Cross-process registry lock | 3b183f2 |
| 4 | Deploy config honors durability | 4aa0be3 |
| 6 | Critical web async holes | b92ae3f |
| 7 | Shared web async hooks | 2b318a5 |
| S8 | Codify O_EXCL sentinel (+ 2 more conventions) | (CLAUDE.md, arm root — not in the git repo) |

**Unverified residue** (flagged in each ADR): live throughput improvement from
the loop-blocking fix (needs a loadtest on a real box); true multi-process lock
contention; `docker build` / `helm template`; a real drain under load; and the
usual web visual/interaction pass. No local TTS runtime, Docker or dev server.

## Strong patterns observed
- **O_EXCL cross-process sentinel** → codified (docs + `test_file_lock.py`).
- Engine lifecycle discipline and honest-failure surfaces (codified earlier
  today) both gained notes: this scan found their *edges*, not their centers.
- Event-loop discipline recorded as a strong pattern now that the offenders are
  fixed and `test_handler_modes.py` guards it.

## Cross-references
- Extends the shipped perfect direction [[skip-abandoned-jobs]] — the abandon
  mechanism existed; two routes never used it.
- Collides with [[replica-native-mode]]: the multi-process topology it shipped
  is exactly what broke the registry lock (fixed) and makes ingest
  replica-affine (now documented rather than silently 404-ing).
- Earlier run: [[Architect/scans/2026-07-26-error-handling]].
