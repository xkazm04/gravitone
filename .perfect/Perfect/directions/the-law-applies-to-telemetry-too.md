---
slug: the-law-applies-to-telemetry-too
type: perfect/direction
context: "[[concurrency-engine-metrics]]"
lens: robustness
status: shipped
size: S
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: 48d223e
---
## What & why
Two stores violate the repo's own cross-process law (bare threading.Lock guarding a file all replicas write): `direction.py` and `demand.py` — and the loss is whole-file (every delta between two replicas' RMW windows), on the file described as a future training corpus. `takes.py:revise_review` RMWs with no lock and non-atomic write_text. Two new cross-thread races: the fabric admin thread reads `SYNTH_CACHE.stats()` and iterates a live worker's voice LRU while loop/worker mutate them — affinity silently vanishes exactly when the box is busy.

## Evidence
- direction.py:40 + :128-147; demand.py:28 + :53-60; buildstore.py:600 the correct pattern
- takes.py:591 revise_review RMW; :283-284, 513, 632, 671 bare write_text
- cache.py:110-165 lock-free SynthCache read from replicas.py:916-921 admin thread; engine.py:1286-1288 LRU iteration vs :830-833 mutation, swallowed at replicas.py:430-431

## Acceptance criteria
- direction.py + demand.py adopt atomicio.file_lock (+ atomic replace) for their RMW.
- takes.py review/take JSON writes become atomic; revise_review cross-process safe.
- SynthCache.stats() and voice_lru_keys safe under cross-thread read (lock or snapshot-copy), no swallowed RuntimeError path.
- Multi-process tests for the two stores; a concurrency test for the two race sites.

## Risks / non-goals
Non-goal: changing what is recorded. Keep hot-path cost near zero (stats snapshot, not global locking of synthesis).

## Build record
(pending)
