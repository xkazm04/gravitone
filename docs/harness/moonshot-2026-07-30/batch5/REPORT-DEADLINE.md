# REPORT — DEADLINE (Deadline Contract Engine), Batch 5

> Saved by the orchestrator from the builder's inline report. Patches A (app.py) and
> B (convai.py) applied by the orchestrator at integration.

**Status: G1 complete.** service/engine.py (sole owner) + test_deadline_engine.py (29).

Implemented: Metrics.cost_model()/cost_estimate() from existing _proc/_audio windows —
basis warm|cold|insufficient, widened by measured p95/p50 spread (clamped), promise only
when warm; nested under snapshot()["cost_model"] so no new top-level scalar hits AGG_KEYS.
AdmissionRejected gained predicted_wait_s/retry_after_s/reason/payload() (still
constructible with a message alone). Job gained deadline_s (None = FIFO), job_class,
degrade_allowed, est_synth_s, promised_s, quality_level, settle_hook. _DeadlineQueue wraps
PriorityQueue on (priority, seq) — payload never compared, sentinel at +inf. Aging baked
into the enqueue-time key (bulk horizon 30s vs interactive 2s) — no sweeper to stop.
_INTERACTIVE_RESERVE defaults 0 (a floor changes who gets 429s — deliberate). Elastic
quality walks a ladder, stops at the cheapest rung that fits, never lowers a caller-pinned
knob, stamps quality_level.

Evidence: test_deadline_engine 29/29; 8 gate modules 123/123; FULL service suite 1416 OK
(5 skipped); py_compile clean.

Patch A (app.py): TTSRequest gains deadline_s/degrade_allowed; _submit_and_wait passes
contract kwargs only when used (test doubles predate them) + `promise` out-param;
_Backpressure carries the AdmissionRejected so 429s report predicted wait + real
Retry-After; X-Gravitone-Deadline / X-Quality-Level headers (promise only from a warm
window; quality only when not "full"); CORS list extended.

Patch B (convai.py): _interactive_kwargs(engine) — feature-detected + cached per engine
type (test doubles predate admission classes); _Session._synthesize tags turns interactive.
With TTS_INTERACTIVE_RESERVE unset (default 0) the tag changes ordering only, never who
gets a 429.
