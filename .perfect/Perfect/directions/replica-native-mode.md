---
slug: replica-native-mode
type: perfect/direction
context: "[[Concurrency Engine & Metrics]]"
lens: wildcard
status: shipped
size: M
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: d2e8dae
---
## What & why
The engine's central premise is contradicted by its own harness: loadtest + certify hardcode "TTS_WORKERS=1 + N replicas, model is GIL-bound", yet nothing implements replicas and default workers=2. Phase-1: a --replicas N launcher spawning N single-worker uvicorn processes on one port (SO_REUSEPORT), per-replica BLAS/OMP thread env tuned for Arm cores, aggregated /metrics view. The Arm throughput story the benchmarks want to tell.
## Evidence
loadtest.py:133-135, 159-163; certify.py:102-107; config.py:54, 58-60, 64; engine.py:291.
## Acceptance criteria
- one command starts N replicas sharing a port
- each replica pins TTS_WORKERS=1 + correct OMP/BLAS thread env
- /metrics aggregation across replicas
- certify/loadtest recommendation matches what the product runs
- documented in README
## Risks / non-goals
SO_REUSEPORT is Linux-only (fine — deploy target is Arm Linux; dev-box fallback documented). No shared model memory (follow-up).
## Build record
Wave 2, 2026-07-13. Opus builder; Director-reviewed; gates green (compileall + 73 unittests). d2e8dae (BEHAVIOR CHANGE: TTS_WORKERS default 2->1). Note: export_stems in-process serializer is verified by load-back + falls back to the proven pocket_tts export-voice CLI; needs one integration run on a box with the model.
