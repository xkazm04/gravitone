---
slug: arm-inference-pass
type: perfect/direction
context: "[[Speech Synthesis API]]"
lens: wildcard
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 10099c4
---
## What & why
Gravitone is positioned as Arm-native CPU-only TTS, but the inference path never got an Arm pass. Quantization is off by default and its own comment cites x86 numbers; the generation call runs without `inference_mode`; interop threads and denormal handling are untouched; the bf16 fast-math env var exists only in the Dockerfile, so a bare-metal replica run silently loses it; and ffmpeg spawns unbounded threads that compete with the cores the launcher just pinned. Each item is small; together they are the difference between claiming Arm performance and measuring it.

## Evidence
- `service/config.py:69` — `quantize: bool = _bool("TTS_QUANTIZE", False)  # int8; ~27% faster on x86` — x86-only justification on an Arm product; no qnnpack/oneDNN qengine selection anywhere.
- `service/engine.py:387` — `generate_audio(...)` with no `torch.inference_mode()` / `no_grad`.
- `service/engine.py:430` — `torch.set_num_threads` only; no `set_num_interop_threads`, no `set_flush_denormal`.
- `Dockerfile:30` — `ONEDNN_DEFAULT_FPMATH_MODE=bf16` set ONLY here; `service/replicas.py:83-95` `replica_env` pins `TTS_TORCH_THREADS/OMP/OPENBLAS/MKL` but not this.
- `service/engine.py:86-90` — ffmpeg subprocess with no `-threads` cap, running while torch threads are pinned.
- `service/config.py:65` — `torch_threads` default 4 assumes a 4-core box; only the launcher derives from `os.cpu_count()` (`replicas.py:78`).

## Acceptance criteria
- Inference-path settings applied (`inference_mode` around generation, interop threads, flush-denormal, Arm quantized-engine selection when `quantize=True`), each individually revertible via an env flag with a documented default — no silent behavior change.
- `ONEDNN_DEFAULT_FPMATH_MODE` moves into `replicas.replica_env` (still set in the Dockerfile) so bare-metal and container runs match.
- ffmpeg invocation thread-capped so encoding cannot oversubscribe the pinned inference cores.
- The x86-only comment on `quantize` is replaced with what is actually known, and the Arm quantization path is either enabled with evidence or left off with a stated reason.
- A repeatable A/B script reports realtime-factor per setting using the EXISTING bench harness (`service/loadtest.py` / `service/certify.py`) — no new benchmarking framework.
- **Honest verification report**: torch/pocket-tts are NOT installed on the dev box, so the builder states precisely which settings it could not execute, and no speedup number is claimed that was not measured.

## Risks / non-goals
- Highest unverifiable-runtime risk of the round — CLAUDE-log rule from round 1 applies: when swapping a proven invocation for a new one, keep a fallback to the proven path and make every change revertible by flag.
- Touches `service/engine.py` and `service/replicas.py`, owned by the Concurrency Engine & Metrics context — pre-authorized for this direction; changes there stay confined to thread/inference/env settings.
- Non-goal: batching multiple texts into one `generate_audio` call, thread affinity/`sched_setaffinity`, and any change to the replica/`SO_REUSEPORT` topology.

## Build record
Builder S2 (branch commit 7c4153b → cherry-picked to main as 10099c4), plus Director fix 6f2d1b0. Applied, each behind an env flag with a documented default: `torch.inference_mode()` around generation (`TTS_INFERENCE_MODE=0` → no_grad) with an automatic one-time demote-and-retry if the model rejects inference tensors; `set_num_interop_threads` (`TTS_TORCH_INTEROP_THREADS`, default 1, late call logged not fatal); `set_flush_denormal` (`TTS_FLUSH_DENORMAL`); qnnpack selection on aarch64 when quantizing (`TTS_QUANTIZED_ENGINE=auto`); ffmpeg `-threads/-filter_threads` cap (`TTS_FFMPEG_THREADS`, default 1). `ONEDNN_DEFAULT_FPMATH_MODE=bf16` now set by `replicas.replica_env` (setdefault) AND still in the Dockerfile, so bare metal matches the container. `/metrics` `config.tuning` reports what ACTUALLY took effect, not what was requested (set_flush_denormal can refuse, interop can be too late, inference_mode can self-demote). New `benchmark_arm_ab.sh` drives the EXISTING `service.loadtest` one knob at a time and labels each row with the /metrics readback. `quantize` stays OFF with the x86-only comment replaced by the real reason.

**Honest verification (as briefed)**: the builder ran ZERO real inference — torch/pocket-tts are not installed on this box — and claims no speedup number anywhere in the repo or the commits. Unmeasured: inference_mode (incl. whether pocket-tts tolerates it, which is exactly why the demote-and-retry exists), interop threads, flush-denormal, qnnpack int8, oneDNN bf16, ffmpeg cap. `benchmark_arm_ab.sh` has never been run (bash -n checked; summary block smoke-tested on fabricated JSON). Tests verify the REQUESTS the engine makes and the fallback logic against the shim, not performance.

**Director review**: read the full diff. Ran the docs-vs-code check (round-1 rule) and caught one real discrepancy: the README claimed "every one of those settings is applied by default" while listing `TTS_QUANTIZE`, which is deliberately off — fixed inline as Director commit **6f2d1b0** rather than a builder redo. Verified every setting the README names is actually implemented in `config.py`/`engine.py`/`replicas.py` (the round-1 lesson: a beautifully-documented formula whose SQL was never written). The round-1 "keep a fallback to the proven path" rule is honoured twice over — inference_mode self-demotes to no_grad and retries the same call, and every knob has a revert value. Accepted the builder's reasoned refusal to derive `torch_threads` from `os.cpu_count()` (replicas.per_replica_threads already owns that for the shipped topology; changing an unmeasurable global default is the exact briefed risk). Gates on main: compileall clean, 244 passed + 14 subtests. MERGED.

**Follow-ups the builder correctly flagged out of scope**: (1) with `TTS_API_KEY` empty the whole service including `/v1/keys` admin is open — managed-key revocation is now real but a deploy that never sets the var gets none of it; worth an explicit decision. (2) The web studio has NO revoke affordance — `web/app/api/keys/[id]/route.ts` proxies DELETE only, so the new endpoint is API-only until the API Key Management context catches up. Both recorded in the context note as round-5 candidates.
