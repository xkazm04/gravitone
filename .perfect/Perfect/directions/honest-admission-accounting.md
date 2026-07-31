---
slug: honest-admission-accounting
type: perfect/direction
context: "[[Concurrency Engine & Metrics]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: f5f0e27
---
## What & why
The engine keeps charging admission for requests that no longer exist. When a request times out (504) or the client disconnects, the job is marked abandoned but keeps its permit until a worker eventually dequeues it — with one worker and a deep queue that is minutes of capacity held for a caller who is gone, at exactly the moment the service is most loaded. The counters that report this are also unguarded: `queued` can go negative, and `in_flight` inflates permanently if a worker dies at the wrong instant.

## Evidence
- `service/app.py:186-195` — timeout/disconnect sets `job.abandoned`; `service/engine.py:506` — the permit is released only when a worker dequeues the job and sees the flag.
- `service/engine.py:328,335,344` — `queued` has no floor; correctness depends on every enqueue being matched by exactly one of `on_start`/`on_abandoned`/`on_drain`, with no guard, and it is exported raw.
- `service/engine.py:519` — a worker dying between `on_start` and the `try` never decrements `in_flight`.
- `service/app.py:701-715` — cache hits and single-flight collapses take no permit and never call `on_received`, so the counters no longer describe the traffic (shares a seam with [[benchmark-measures-engine]]).
- `service/tests/fake_engine.py:202-231` — the fake IGNORES `job.abandoned` entirely: abandoned jobs still run and hold their slot, so no HTTP-level test can currently prove that abandoning frees capacity.

## Acceptance criteria
- An abandoned job's admission permit is released when it is abandoned, not when it is finally dequeued — a disconnected client stops costing capacity immediately.
- A job whose permit was released early cannot be double-released or double-run when a worker later reaches it.
- Counters cannot go negative or leak: `queued`/`in_flight` are guarded, and a worker dying mid-job does not permanently inflate the gauge.
- `FakeEngine` learns `job.abandoned` so the behaviour is provable at the HTTP level, and a test asserts capacity actually returns.

## Risks / non-goals
- The permit/queue/worker handoff is the most concurrency-sensitive code in the service — the CLAUDE.md rule holds absolutely: every future resolves exactly once and every permit releases in a `finally`, on every path.
- Non-goal: new metrics surfaces or dashboards (an earlier round rejected `one-truth-metrics`); this is accounting correctness that causes real 429s, not reporting.

## Build record
Builder E-A. `Job.abandoned` is now an `_AbandonFlag` whose `set()` runs an engine hook that releases the permit immediately, cancels the future, and leaves a tombstone in the queue — **no app.py call site changed**, so timeout, disconnect, batch abandon and stream teardown all still just call `.set()`. The crux is structural: `Job.claim()` is a one-shot claim that the worker, the abandon hook and the drain must each win before touching the job's ONE permit and ONE future, so double-release and double-run are impossible by construction; abandoning an already-running job correctly does NOT return a live permit. `queued`/`in_flight` floored at zero; `in_flight` owned solely by a `Metrics.job_running()` context manager that decrements in a `finally` (a worker dying mid-job no longer inflates the gauge — tested with a BaseException). Added `on_cache_hit()`/`on_collapsed()` plus `cache_hits`/`collapsed` to the snapshot for the cache sibling; `cache.py` untouched. `FakeEngine` now honours `abandoned` by IMPORTING `_AbandonFlag` rather than re-implementing it, so it cannot drift.

**Director review**: read all three claim sites (`_serve_once`, `_drain_queue`, `_release_abandoned`) and verified exactly one owner per job on every interleaving, and that the worker claims BEFORE checking the abandoned flag so an abandoned-while-queued job still releases correctly through the worker path. Verified `test_abandon.py`'s old assertion — "the future resolves when the worker dequeues B" — encoded the very behaviour this direction removes, and was updated deliberately, not deleted. The builder ran the four concurrency-sensitive files 3x back-to-back with no flakes. One cross-boundary edit accepted: a single additive line in the sibling's `replicas.py` AGG_KEYS, which the drift test forces. Gates on main: 324. MERGED.
