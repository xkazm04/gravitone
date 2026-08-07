---
name: Concurrency Engine & Metrics
type: perfect/context
group: TTS Service Core
category: lib
opportunity: 8
last_proposed: 2026-07-28
cooldown_until: round 7
directions: ["[[skip-abandoned-jobs]]", "[[graceful-drain-shutdown]]", "[[replica-native-mode]]", "[[priority-lanes]]", "[[one-truth-metrics]]", "[[benchmark-measures-engine]]", "[[segmentation-earns-its-keep]]", "[[worker-death-is-visible]]", "[[honest-admission-accounting]]", "[[pool-truth-aggregation]]"]
---
## Current state (RE-SCOUTED 2026-07-28, round 5 — the round-1 brief below was stale)
Re-scouted deliberately: round 4 changed `engine.py` underneath this context (Arm inference tuning, `_generation_context`, ffmpeg thread cap) and added `service/cache.py`. The scout was given the round-4 SHAs to read first.

**Topology (load-bearing fact):** `workers` defaults to 1 (`config.py:59`) AND `replicas.replica_env` hard-pins `TTS_WORKERS=1` for every child (`replicas.py:103`) — one process = one model = one generation at a time. Parallelism is entirely ACROSS processes. Admission = `workers + queue_max` = 33 slots per replica (`engine.py:582`); the queue itself is unbounded, the semaphore is the only bound.

Confirmed live and healthy: the drain protocol (flip `_stopping` under `_enqueue_lock` → resolve every queued future → sentinels → join → second sweep, `engine.py:597-626`), abandon-skip + permit release, the replica launcher (thread pinning, bf16, SO_REUSEPORT with the parent closing its own fd so a crashed child leaves the group, backoff supervision), and round 4's cache single-flight semantics (`cache.py:159-195`).

Rough (Director-verified where structural):
- **The benchmark measures the cache, not the model** — loadtest sends one constant text, cache defaults on, harness never mentions it; hit RTF = audio/1e-6 → millions, ingested into `server_rtf_mean` and the signed certificate. → [[benchmark-measures-engine]]
- **Segmentation buys nothing in the shipped topology** — 16 units queue behind ONE worker and run serially while claiming 16 of 33 slots; the route docstring claims N-worker concurrency. → [[segmentation-earns-its-keep]]
- **Worker startup failure hangs `start()` forever** (`engine.py:482,594`); **a worker dying mid-loop is silent** — `/health` stays 200, permits drain, permanent 429, and the process supervisor only watches processes. → [[worker-death-is-visible]]
- **Abandoned jobs keep their permit until dequeued** (`app.py:186-195` vs `engine.py:506`); `queued` can go negative; `in_flight` leaks on worker death; cache hits bypass `on_received`. → [[honest-admission-accounting]]
- **Aggregated /metrics is N random samples** under the reuse-port default (`replicas.py:137-143`), consumed as truth by the certificate; `audio_seconds_total` missing from `AGG_KEYS`. → [[pool-truth-aggregation]]
- Not taken this round: `/metrics` + `/health` unauthenticated and leaking `ENGINE.config()` (`app.py:1130`); `_pct` sorts the 512-deque 4× per `snapshot()` and `_backpressure_response` pays it on EVERY 429 (`engine.py:362-393`, `app.py:298`); `available_permits()`'s docstring forbids reaching into `Semaphore._value` and its body returns exactly that (`engine.py:658-665` — both callers are tests that bypass it anyway); `_VOICE_CACHE_MAX = 8` is the one knob that is not env-configurable, and the LRU is per-worker so a 4-replica pool misses ~7/8 on first touch per replica; `audio_to_wav_bytes` runs inside the worker holding the permit but is excluded from `synth_s` (`engine.py:539-540`); the default executor (concat/resample/ffmpeg) is not sized against the pinned inference budget; `max_tokens` still process-global with a dead `submit(max_tokens=)` parameter.
- **`fake_engine.capacity` is FIXED** (`_admitted` now = in-flight + queued, `fake_engine.py:197,229`) — the round-4 concern is resolved. Residual: the fake ignores `job.abandoned` entirely, so no HTTP-level test can prove abandoning frees capacity.

## Previous state (scouted 2026-07-13, round 1 — historical)
Pool of N TTSModel worker threads, semaphore admission → 429, unbounded FIFO, per-job Future, overrides restored in finally. Rough at the time: timed-out jobs kept running and held permits; lossy shutdown; single FIFO head-of-line blocking; two RTF definitions; voice-load folded into synth time; no replicas implemented despite the harness recommending them. Most of this was fixed by rounds 1 and 4.

## Direction history
2026-07-13 — proposed 5: skip-abandoned-jobs ✅ graceful-drain-shutdown ✅ replica-native-mode ✅ priority-lanes ❌ one-truth-metrics ❌ (both rejected as metrics-dashboard-flavored).
2026-07-28 — proposed 5, **all 5 accepted**: benchmark-measures-engine ✅ segmentation-earns-its-keep ✅ worker-death-is-visible ✅ honest-admission-accounting ✅ pool-truth-aggregation ✅. Two of the five are cleanup of round-4 regressions the Director shipped. Framed as accounting/measurement CORRECTNESS rather than reporting — that is what kept them clear of the round-1 metrics-dashboard rejection, and the user accepted the full slate.

## Shipped
Round 1: skip-abandoned-jobs → b5bae02 (+28b68a0 Director) · graceful-drain-shutdown → 81ccb72 · replica-native-mode → d2e8dae (TTS_WORKERS default 2→1)

Round 5 (2026-07-28) — 5/5:
- [[benchmark-measures-engine]] → **a1e2a16** — cache-bypass path so the benchmark measures the model again; `X-Realtime-Factor: n/a` on hits; cert schema bumped so old artifacts are REFUSED.
- [[pool-truth-aggregation]] → **da5cd76** — one scrape target under SO_REUSEPORT; publishes `pool_total` with real sums or `single_replica_sample` with `totals: null`; `audio_seconds_total` now aggregates.
- [[worker-death-is-visible]] → **718a790** — startup fails loudly instead of hanging forever; worker loop survives or dies visibly; `/health` reads live workers.
- [[honest-admission-accounting]] → **f5f0e27** — `Job.claim()` one-shot ownership; an abandoned job's permit is released the moment the caller gives up.
- [[segmentation-earns-its-keep]] → **d9dd0d1** — batch cap derives from real parallelism; at the shipped `workers=1` the drop-in route is one job again. Also fixed the round-4 test that proved concurrency against a topology that never ships.

**Observed effect**: 274 → 415 service tests across the round. Two of the five were cleanup of round-4 regressions the Director shipped.

## Round 9 (2026-08-04) — re-scout post-moonshot + slate
Moonshot added deadline engine, fabric/router, perf-ledger, buildstore, ratelimit. Scout 2026-08-04: deadline reaches engine from ONE branch only; promises never measured (invented 0.7/0.5 fractions, degrade-when-hopeless); ratelimit per-process (N× budget lie; router mode → one global bucket, no XFF); direction.py/demand.py violate cross-process law; SynthCache/voice-LRU cross-thread races; /v1/build sequential + per-line offload hops; router/drain_and_replace unreachable in shipped topology; README documents none of it.
Slate: [[deadline-reaches-every-route]] [[promises-are-measured]] [[shared-limits-that-tell-the-truth]] [[the-law-applies-to-telemetry-too]] [[build-joins-the-pool]] — ALL 5 ACCEPTED (clean sweep).
cooldown_until: round 11
