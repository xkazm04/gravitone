---
slug: segmentation-earns-its-keep
type: perfect/direction
context: "[[Concurrency Engine & Metrics]]"
lens: optimization
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: d9dd0d1
---
## What & why
Round 4's [[parallel-longform-tts]] splits a long body into up to 16 units and submits them as one batch, on the premise that N units occupy N workers. In the SHIPPED topology that premise is false: `workers` defaults to 1 and the replica launcher hard-pins `TTS_WORKERS=1` for every child, so all 16 units queue behind ONE worker and run serially — the same total model work plus per-unit overhead plus `concat_wavs` — while claiming 16 of that replica's 33 admission slots. The round-4 test proved concurrency against a fake engine configured with multiple workers; it never ran the topology the product actually ships.

## Evidence
- `service/config.py:59` `workers: int = _int("TTS_WORKERS", 1)`; `:55-58` explicitly recommends scaling by PROCESS, not in-process worker. (Director-verified.)
- `service/replicas.py:103` — `env["TTS_WORKERS"] = "1"` for every spawned replica. (Director-verified.)
- `service/app.py:442-456` `_max_batch_units()` = `min(16, (workers+queue_max)//2)` = 16 on defaults; `:667` the drop-in route passes it; `:683` the batch is submitted at once.
- `service/app.py:638-640` — the route docstring claims "an N-unit body occupies up to N workers concurrently".
- `_max_batch_units` derives its ceiling from `workers + queue_max` — a QUEUE-DEPTH knob, not a parallelism knob, so raising `queue_max` for backpressure headroom silently raises how much of it one caller can claim.

## Acceptance criteria
- Segmentation's admission cost is proportional to the parallelism actually available (collapse or skip when `workers == 1`, derive the cap from real parallelism, or a better answer the builder can defend).
- Every docstring and comment states what is true for the shipped topology — no claim of concurrency a single-worker replica cannot deliver.
- A test runs at `workers=1` (the shipped default, not a multi-worker fake) and pins that a long body neither hogs the admission window nor pays net-negative overhead.
- The streaming route's time-to-first-byte win is preserved untouched — that one is real regardless of worker count.
- Single-unit byte-identity (round 4's contract) still holds.

## Risks / non-goals
- Do not simply revert [[parallel-longform-tts]]: the batch path is correct for a `TTS_WORKERS=N` deployment and the streaming win is genuine. The goal is that the cost matches the benefit in the topology that ships.
- Non-goal: changing the replica topology or the `workers=1` recommendation.

## Build record
Builder E-C. `_max_batch_units()` now derives from `SETTINGS.workers` (real parallelism) instead of `workers + queue_max` (a queue-depth knob), still bounded by `_MAX_BATCH_UNITS=16` and half the admission window. At `workers == 1` it returns 1, and `_chunk_text` short-circuits a cap of 1 to `[text.strip()]` rather than running the budget-doubling loop to re-derive the same answer.

Behaviour delta: on the SHIPPED single-worker replica the drop-in route no longer batches at all — any body, 12 chars or 8000, is one job and one admission slot (was up to 16 of 33), no concat seams, byte-identical to the pre-segmentation path. Nothing is slower, because the units were running serially anyway. For `TTS_WORKERS=N` batching is intact with the cap at `min(16, N, (N+queue_max)//2)`. The streaming route is untouched: it passes no cap, so its TTFB win survives at every worker count, pinned by a new subtest at workers=1 and workers=4.

**Director review**: read the diff. Every docstring and the `chunk_chars` config comment now state what is true for the shipped topology — the round-4 failure was a false claim in this exact function, and the replacement text is careful about who splits and why. **The builder also fixed the test bug that caused the round-4 miss**: every batch case previously configured only the FakeEngine's pool size, leaving `SETTINGS.workers` at 1, so the suite proved concurrency against a topology that never ships. `_chunk_every_sentence(workers)` is now a REQUIRED argument, the multi-worker cases live in an explicitly-labelled `MultiWorkerBatchTests`, and `SingleWorkerTopologyTests` asserts `SETTINGS.workers == 1` outright. Gates on main: compileall clean, **347 passed, 25 subtests**. MERGED.

No throughput number claimed — the "batching was net-negative on one worker" argument is structural (unit count x per-unit overhead), not measured, since torch is absent.
