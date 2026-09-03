---
slug: benchmark-measures-engine
type: perfect/direction
context: "[[Concurrency Engine & Metrics]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: a1e2a16
---
## What & why
Round 4 shipped a synthesis cache that defaults ON at 128 MiB. The load-test harness sends ONE constant text for every request at every concurrency level and knows nothing about the cache. So after the first request, every drop-in-route sample is a cache hit: the knee, the 429 count, the realtime factor and the **signed certificate** all measure an LRU lookup instead of the model. This is a regression introduced by [[synthesis-cache]] and it invalidates the product's headline performance claim.

## Evidence
- `service/loadtest.py:47-49` `TEXT_DEFAULT` (two sentences, constant); `:840` `--text` defaults to it; every level reuses it. (Director-verified.)
- `service/config.py:163` — `cache_bytes` defaults to 128 MiB, cache ON.
- `grep -i cache service/loadtest.py service/certify.py` → **no hits**: the harness never disables, bypasses or mentions it. (Director-verified.)
- `service/app.py:710,750` — on a hit `synth_seconds` is `round(perf_counter()-t_request, 6)` ≈ 1e-6, so `X-Realtime-Factor` = audio/1e-6 → millions.
- `service/loadtest.py:427` ingests that header into `results["rtf"]`; `:563` averages it into `server_rtf_mean`; `:121-122` is the CPU-ceiling knee detector testing `srtf < 1.0` — which can never fire on cached numbers. (Director-verified.)
- Cache hits never call `on_received` (`app.py:701-715`), so `Metrics.received` no longer means "requests".

## Acceptance criteria
- The benchmark path measures synthesis, not cache lookup (bypass header / env / per-request corpus variation — builder's call, documented, and defaulted so an unaware operator gets honest numbers).
- A cache hit never reports a fabricated realtime factor; whatever it reports is defensible as a measurement of that request.
- Cache hits and single-flight collapses are visible in `Metrics` so `received` is once again the count of requests served.
- A test asserts the benchmark corpus actually reaches the model — a regression here fails the suite, not a demo.
- Certificates produced before this fix are distinguishable from ones after (schema/version note), so an old artifact is not mistaken for a valid measurement.

## Risks / non-goals
- Do NOT solve this by turning the cache off by default — the cache is a real product win; the benchmark is what must be honest.
- Pre-authorized cross-context: `service/loadtest.py`, `service/certify.py` (Load Testing & Benchmarks) and the cache/header block in `service/app.py` (Speech Synthesis API).

## Build record
Builder E-B. Added `app.cache_bypass_requested`: a request carrying `Cache-Control: no-store`/`no-cache` or `X-Gravitone-Cache: bypass` renders from scratch with NO lookup, NO single-flight collapse and NO store (so a benchmark corpus cannot evict real callers' audio). `X-Cache` now reports hit|miss|bypass and `SynthCache.bypassed` counts them. A cached response reports `X-Realtime-Factor: n/a` instead of audio/1e-6; `X-Synth-Seconds` still carries the request's true serve cost. The harness `--cache-mode` DEFAULTS to bypass, so an unaware operator gets model numbers; every level records `cache_hits`/`measures_synthesis`, a contaminated level warns loudly, result schema v2 to v3, `CERT_VERSION` to `gravitone-cert/2` with a new FIRST check `measures_synthesis` that refuses any run which allowed the cache or predates v3. Regression guard `BenchmarkReachesTheModelTests` fires the harness's actual request at the real app + fake engine (3 requests to 3 engine jobs, 0 cache entries), with a sibling test proving the same corpus IS a hit without the headers.

**Director review**: the brief's hard constraint was "do not fix this by disabling the cache" and the builder honoured it exactly — the cache stays ON at 128 MiB and only the measurement path changed. Verified `Request` is imported in app.py so the injected parameter is real, and that no repo artifact or web surface reads the invalidated fields. Confirmed the README's Graviton numbers date from 2026-07-12, BEFORE the cache existed, so they remain honest measurements and needed no correction. Gates on main: compileall clean, 305 at merge (341 after the wave). MERGED.

**Operator action this creates**: any existing loadtest_result.json / certification.json OUTSIDE the repo is invalid and `certify` will now refuse it. The Arm box needs a re-run before any capacity claim is republished.
