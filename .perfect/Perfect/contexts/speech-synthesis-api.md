---
name: Speech Synthesis API
type: perfect/context
group: TTS Service Core
category: api
opportunity: 8.5
last_proposed: 2026-07-28 (round 6)
cooldown_until: round 8
directions: ["[[streaming-synthesis-endpoint]]", "[[elevenlabs-dropin-compat]]", "[[parallel-multisegment-synthesis]]", "[[keys-error-hardening]]", "[[per-key-usage-metering]]", "[[parallel-longform-tts]]", "[[stream-chunk-budget]]", "[[synthesis-cache]]", "[[key-lifecycle-truth]]", "[[arm-inference-pass]]", "[[honest-self-reported-numbers]]", "[[premium-route-batch-cap]]", "[[browser-usable-api]]", "[[premium-output-format]]", "[[private-surface-not-published]]"]
---
## Current state (scouted 2026-07-13)
Pipeline: app.py route → emotion resolve → ENGINE.submit → worker TTSModel → wav bytes → optional ffmpeg mp3. Works: EL-shaped TTS route with timing headers, wav/mp3/pcm, scoped key auth (auth.py), key mgmt (keys.py), 429 backpressure, /health, /metrics (bespoke JSON). Beyond EL: emotion addresses (sarah:excited), /v1/speak metatags, /v1/performance scripts, packs, takes/reviews, certify.
Rough: no streaming/websocket/timestamps; /v1/voices bare list (voices.py:271); similarity_boost/style ignored (app.py:70-87); mp3 bitrate hardcoded 128k (engine.py:76); sample-rate suffixes ignored; PCM content-type audio/basic (app.py:163); max_tokens pinned to 50 default (config.py:71); frames_after_eos leaked as public field; error details leak (app.py:116); keys.json write race (keys.py:140); rotate un-revokes (keys.py:118); /speak and /performance serial per segment (app.py:257-272, 326-344); executor-thread parking (app.py:110); metrics miss timeouts/queue percentiles/per-voice; no request logging; open-by-default auth; quantize note is x86-only (config.py:64) despite Arm positioning.
## Current state (scouted 2026-07-28, round 4 — post-/architect)
Routes verified reachable: `/v1/text-to-speech/{id}` (app.py:457), `/stream` (:513), `/v1/speak` (:660), `/v1/performance` (:743), `/health` (:821), `/metrics` (:834), + routers voices(13)/keys(5)/ingest(7)/packs(2)/takes+reviews(7).
Round-1..3 work all CONFIRMED LIVE: streaming (complete, incl. pre-stream 429 + abandon-on-teardown), EL compat (envelope, output_format grammar, xi-api-key+Bearer, X-Ignored-Settings), parallel segments (`_submit_batch`/`_gather_results` — **only** on /speak + /performance), key hardening (constant-time compares, corrupt-store loud fail, rotate-409, debounced last_used), graceful drain, skip-abandoned, replica-native. /architect additions confirmed: `errors.sanitized_500` + catch-all (app.py:78), `_offload` (app.py:266, used ×5), all blocking router handlers sync `def`, ingest teardown protocol, abandon on batch routes.

Rough (verified by Director where structural):
- **Main EL route never segments** — whole ≤8000-char body as ONE job (app.py:469) while /stream splits and /speak batches. Biggest latency leak. → [[parallel-longform-tts]]
- **Stream submits every sentence up front** (app.py:560-566) vs admission 33 (engine.py:434) → scripts >~33 sentences are guaranteed 429; `request_timeout_s` applied PER SEGMENT (app.py:581). → [[stream-chunk-budget]]
- **No synthesis cache anywhere**; identical concurrent requests each take a permit. → [[synthesis-cache]]
- **`revoked` never set True** (keys.py:54/132/147/181, DELETE hard-deletes :156-165); `api_keys.json` guarded by threading.Lock ONLY (keys.py:38) across N replica processes; validate = full JSON load + linear scan per request (:176-177). `atomicio.file_lock` has one caller total (voices.py:237). → [[key-lifecycle-truth]]
- **Arm story unfinished**: quantize=False with x86-only comment (config.py:69), no inference_mode (engine.py:387), no interop/denormal settings (engine.py:430), bf16 only in Dockerfile:30 not replica_env, ffmpeg threads uncapped (engine.py:86-90). → [[arm-inference-pass]]
- Not taken this round: no timestamps route / EL user+history+settings routes / CORS middleware (none anywhere); `model_id` accepted and never read (app.py:159); /v1/speak + /v1/performance have no `output_format` (always WAV, :721/:810); `/metrics` + `/health` unauthenticated and leak ENGINE.config(); `/v1/voices/{id}` 404 puts a dict in `detail` (voices.py:490) unlike every other error; worker `load_model` failure leaves `engine.start()` blocked forever (engine.py:341/447); `max_tokens=50` global with dead `submit(max_tokens=)` param despite config.py:78 claiming per-request override; dead code `resample_pcm16` import (app.py:41), `voices.invalidate()` (voices.py:245) no prod caller, `default_voice` docstring wrong (config.py:75 — unknown voice 404s, no fallback).

## Round-6 re-scout (2026-07-28) — post round-5
Re-scouted rather than banked: `app.py` changed substantially in round 5 (cache bypass, abandon-flag permit release, worker supervision, the batch cap now deriving from `SETTINGS.workers`). Confirmed live: revoke endpoint, the cache bypass path, `X-Realtime-Factor: n/a` on hits, `/health` reporting live workers, and the drop-in route being single-job at the shipped `workers=1`.

New/confirmed rough:
- **`/v1/speak` + `/v1/performance` still SUM concurrent segment times into `X-Synth-Seconds`** (`app.py:1105`, `:1193`) — round 4 fixed the drop-in route and round 5 widened the gap. No test covers these two routes' timing headers, which is why it survived. → [[honest-self-reported-numbers]]
- **`Metrics.on_cache_hit` / `on_collapsed` have ZERO production callers** (Director-verified) — `/metrics` reports 0 forever and `replicas.AGG_KEYS` sums structurally-zero fields. A round-5 loose end the Director merged: the ownership split gave the counters to one builder and the cache call site to another. → [[honest-self-reported-numbers]]
- **No batch cap on speak/performance** (`app.py:1091`, `:1180`) — 64 lines × N metatag segments into a 33-slot window. → [[premium-route-batch-cap]]
- **No CORS anywhere** — the drop-in claim fails at preflight for every browser client. → [[browser-usable-api]]
- **No `output_format` on speak/performance** (`app.py:1114`, `:1203`, hardcoded WAV). → [[premium-output-format]]
- **`/metrics`, `/health`, `/docs`, `/openapi.json` all unauthenticated**, publishing `ENGINE.config()` and the full route catalogue including `/v1/keys`; `_backpressure_response` sorts a 512-deque 4× per 429 on the event loop. → [[private-surface-not-published]]
- Not taken: `model_id` accepted and never read (and its default `"pocket_tts"` contradicts `/v1/models`' `"gravitone_pocket_v1"`); `/v1/voices/{id}` 404 puts a dict in `detail`; no timestamps / `/v1/user` / `/v1/history` / voice-settings routes; cache bypass silently ignored on `/stream` + speak + performance; `max_tokens` still process-global with a dead `submit(max_tokens=)` param; `/stream` can truncate mid-response after a 200.

## Direction history
2026-07-13 — proposed 5: streaming ✅ compat ✅ parallel-segments ✅ hardening ✅ usage-metering ❌ (user declined, no reason).
2026-07-28 (round 6) — proposed 5, **all 5 accepted**: honest-self-reported-numbers ✅ premium-route-batch-cap ✅ browser-usable-api ✅ premium-output-format ✅ private-surface-not-published ✅.
2026-07-28 (round 4) — proposed 5, **all 5 accepted**: parallel-longform-tts ✅ stream-chunk-budget ✅ synthesis-cache ✅ key-lifecycle-truth ✅ arm-inference-pass ✅. Slate was deliberately all engine-depth (no UX lens) per the taste log; user accepted the full slate.
## Shipped
Round 4 (2026-07-28) — 5/5: parallel-longform-tts → 8c4389e (+ fix 2725d2a) · stream-chunk-budget → ac01955 · synthesis-cache → 917e012 · key-lifecycle-truth → 233314c · arm-inference-pass → 10099c4 (+ Director 6f2d1b0)

Round 6 (2026-07-28) — 5/5:
- [[honest-self-reported-numbers]] → **2b84ae1** — speak/performance report wall-clock instead of summing concurrent segments; the dead cache counters are wired, with a test that walks `AGG_KEYS` and fails on any field with no production writer.
- [[premium-route-batch-cap]] → **da365e5** (+ Director flake fix **a018556**) — wave submission bounded by real parallelism; a 64-line × 3-segment script now completes where it used to 429 by construction.
- [[premium-output-format]] → **70b7f63** — `output_format` on both premium routes, reusing `_parse_format`, with `_encode_audio` extracted as the single renderer.
- [[browser-usable-api]] → **0e4d82f** — CORS, default CLOSED, with an expose-header drift guard.
- [[private-surface-not-published]] → **32cd96b** (+ Director KEDA fix **005f574**) — `/metrics` and the docs surface gated when a key is set; `/health` keeps unauthenticated liveness; the 429 path stopped sorting four deques.
