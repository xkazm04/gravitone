# Moonshots — Concurrency Engine & Metrics (2026-07-30)

Context: `service/engine.py` (bounded model-instance pool, admission semaphore,
429 backpressure, `Metrics` window with latency percentiles + RTF, wav concat /
mp3 encode) and `service/replicas.py` (N single-worker uvicorn processes,
SO_REUSEPORT or sequential ports, supervisor, aggregated `/metrics`).
Adjacent: `service/cache.py` (LRU + single-flight), `service/convai.py` (duplex
conversational turns sharing the same pool), `service/piper.py` (second engine).

Both proposals start from the same observation: the engine today knows a great
deal about itself (RTF, p50/p95/p99, in-flight, queue depth, per-worker voice
LRU) and uses almost none of it to make decisions. Admission is a blind
semaphore, ordering is FIFO, and the pool of replicas is load-balanced by a
kernel that knows nothing. The measurement layer is already built; the
*decision* layer is missing.

---

## M1. The Deadline Contract Engine — promise a latency, then keep it

- **Tier**: 1 (10x category-defining)
- **Category**: functionality
- **Impact**: Every caller states a deadline; the engine either accepts with a
  numeric promise it can prove from its own measured RTF, or degrades quality to
  fit, or refuses instantly with the truth. CPU-only TTS stops being "fast until
  it isn't" and becomes a service with an SLO — the single thing that blocks
  serious adoption of a CPU inference box.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: nobody ships TTS with a latency contract — cloud
  vendors sell capacity and let you discover the tail. Gravitone can, because it
  is the rare inference service that owns its whole queue and already measures
  its own real-time factor per window. Turning FIFO + semaphore into
  deadline-aware scheduling with elastic quality means a single Arm box can
  serve interactive conversation and bulk long-form *simultaneously* without
  either starving the other — today a 4000-token audiobook segment sitting in
  front of a live `convai` turn adds tens of seconds of dead air to a phone call.
- **Path to implementation**:
  1. **Cost model in the current scaffold.** Add `Metrics.cost_estimate(text,
     max_tokens)` next to `snapshot()`: seconds-per-token derived from the
     existing `_proc` / `_audio` windows (the data is already collected;
     `realtime_factor` is one aggregate of it). Expose it on `/metrics`, and
     have `submit` attach `est_synth_s` to each `Job`. Zero behaviour change,
     immediately observable, unit-testable against a synthetic window.
  2. **Truthful admission.** Replace the boolean `AdmissionRejected` with a
     predicted wait: sum `est_synth_s` of queued jobs / live workers + own
     estimate. The 429 body (which already returns `counters()`, cheap by
     design) gains `retry_after_s` and `predicted_wait_s`, and the accept path
     returns an `X-Gravitone-Deadline` promise header.
  3. **Deadline-ordered queue.** Swap `queue.Queue` for a `PriorityQueue` keyed
     `(deadline, seq)`. `Job` already carries `t_enqueue`; add `deadline_s`
     (default = current behaviour, i.e. FIFO-equivalent). The claim/tombstone
     protocol and `_drain_queue` are order-agnostic, so this is a container
     swap, not a redesign.
  4. **Class-based preemption.** Two admission pools sharing the worker set:
     `interactive` (convai turns, hero demo) and `bulk` (long-form, batch
     performance renders). Interactive jumps the queue and gets a reserved
     permit floor; bulk gets the rest and an honest, longer promise. `convai.py`
     is the first caller to tag itself.
  5. **Elastic quality instead of rejection.** `Job.overrides` already applies
     per-request expression knobs to a worker's own model instance. When
     predicted wait exceeds the deadline, admit with a reduced
     `lsd_decode_steps` (and shorter `frames_after_eos`) and stamp the response
     with the quality level actually used. A slightly cheaper render that lands
     on time beats a perfect one that 429s.
  6. **Prove it.** Extend `service/loadtest.py` / `certify.py` to report
     deadline-hit rate and promise error (`promised - actual`) alongside the
     knee, so the contract is a measured, certifiable number rather than a claim.
- **Dependencies**: existing `Metrics` windows; `Job.overrides`; the
  claim-based permit protocol (already race-safe); a per-job `deadline` field
  threaded through `service/app.py` request models and `convai.py`.
- **Risks**: a cost model that mispredicts turns promises into lies — mitigate
  by only promising from a warm window (`window_size` gate) and widening the
  promise by measured p95/p50 spread. Priority inversion can starve bulk jobs;
  needs an aging term. Quality degradation must be *visible* in the response or
  it becomes silent quality loss, which is worse than a 429.
- **What changes if we ship it**: Gravitone becomes the only local TTS you can
  put behind a real-time product without over-provisioning, because it tells you
  before it starts whether it will make the deadline.

---

## M2. Gravitone Fabric — turn N blind replicas into one addressable cluster

- **Tier**: 1 (10x category-defining)
- **Category**: platform
- **Impact**: A scheduling-aware router in front of the replica pool that knows
  each replica's queue depth, live workers and *which voices are hot in its LRU*
  — so requests land where they are cheapest, one long utterance fans out across
  all replicas in parallel, and aggregated metrics become real pool totals
  instead of the honest-but-useless `single_replica_sample`.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: today `replicas.py` is deliberately dumb — the kernel
  round-robins connections with zero knowledge, so a request for a cold voice
  can land on the one replica that must load it while a replica with that voice
  already resident sits idle, and a 10-minute narration is pinned to a single
  worker no matter how many cores the box has. Fixing that converts the box from
  "N independent servers that happen to share a port" into one machine whose
  full core count is addressable by a single request. It is also the only route
  to honest pool observability, which every operator surface downstream depends
  on.
- **Path to implementation**:
  1. **Make replicas addressable and self-describing in the current scaffold.**
     `metrics_targets()` / `serving_ports()` already produce the sequential-port
     topology; add an internal admin port per replica (always sequential, even
     when the client-facing port is SO_REUSEPORT) that serves `/metrics` plus a
     new `/introspect` reporting `live_workers`, `available_permits()`, queue
     depth and the worker voice-LRU keys. `aggregate_metrics` then always has N
     addressable targets, so `scope` can be `pool_total` even in reuse-port
     mode — a pure win, no routing yet.
  2. **Least-cost router.** Promote the launcher's metrics server into a small
     stdlib front door that proxies synthesis requests, picking the replica by
     `(free permits, queue depth, voice-affinity hit)`. Voice affinity is the
     sleeper: a hit skips `get_state_for_audio_prompt`, which is the single
     largest avoidable cost on a cold voice.
  3. **Fan-out of one utterance.** Long text is already segmented downstream and
     `concat_wavs` already stitches same-format WAVs with no ffmpeg. Split at
     sentence boundaries, dispatch segments to different replicas concurrently,
     reassemble in order. Time-to-last-byte on long-form drops toward 1/N.
  4. **Prosody continuity across the seam.** The naive version has audible
     joins. Add per-segment overlap and a carried voice-state hint so adjacent
     segments start from comparable conditioning, and gate fan-out behind a
     measured seam-quality check — sequential remains the default for short text
     where fan-out cannot help anyway.
  5. **Rolling replacement.** The supervisor already does restart-with-backoff
     and SIGTERM fan-out; with `/introspect` it can also *drain* a replica
     (stop routing, wait for `in_flight == 0`, replace) — a model or voice update
     with no dropped request.
  6. **One pool view.** Fold the per-replica introspection into a single live
     document: which replica is hot for which voice, where the queue is,
     where the deadline pressure is (composes directly with M1).
- **Dependencies**: `replicas.py` supervisor + `serving_ports`/`metrics_targets`;
  `engine.available_permits()` and `live_workers` (both already public);
  `concat_wavs`; `_Worker._voice_cache` needs a read-only keys accessor. Stdlib
  only, per this module's existing constraint — the launcher must never import
  torch.
- **Risks**: a router is a new single point of failure and a new hop of latency
  (keep it stdlib, thin, and optional — direct SO_REUSEPORT stays the fallback).
  Introspection must be internal-only or it leaks capacity detail. Fan-out
  seams are a real audio-quality risk and must be opt-in until measured.
  Distinct from the deferred "multi-replica voice-embedding sync": this routes
  *to* whichever replica already has the voice rather than replicating state.
- **What changes if we ship it**: a single Arm box stops behaving like N small
  servers and starts behaving like one large one — long-form renders get N-way
  parallelism, cold-voice cost mostly disappears, and the pool finally reports
  numbers an operator can act on.
