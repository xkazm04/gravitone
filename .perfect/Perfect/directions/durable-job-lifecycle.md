---
slug: durable-job-lifecycle
type: perfect/direction
context: "[[Voice Cloning & Ingest Pipeline]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 60784d3
---
## What & why
JOBS is a bare in-memory dict mutated by daemon threads with no lock; jobs + tempdirs vanish on restart; GC only fires when someone starts a new scan; empty/no-speech audio crashes deep in the pipeline (wave.setparams(None), IndexError); uploads have zero validation. Persist job state, lock mutations, schedule GC, validate uploads, clean no-speech errors.
## Evidence
ingest_api.py:47, 70-95, 100, 106-107, 120-121; ingest.py:76-87, 395, 201-209.
## Acceptance criteria
- jobs survive restart (recoverable or cleanly expired)
- all job mutations locked
- GC on a timer
- upload rejects oversize/non-audio/<3s with clear 4xx
- silent clip yields error "no speech detected", not a stack trace
## Risks / non-goals
Keep persistence simple (JSON sidecar in workdir) — no DB.
## Build record
Wave 1, 2026-07-13. Opus builder; Director-reviewed diff; gates green (compileall + unittest + tsc). Commit 60784d3.
