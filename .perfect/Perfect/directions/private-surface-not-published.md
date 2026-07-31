---
slug: private-surface-not-published
type: perfect/direction
context: "[[Speech Synthesis API]]"
lens: wildcard
status: shipped
size: S
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 32cd96b
---
## What & why
The service publishes its own private surface. `/metrics` and `/health` carry no auth dependency and return `ENGINE.config()` — worker counts, thread budgets, quantization, the whole Arm tuning dict — plus full latency percentiles. FastAPI's `/docs`, `/redoc` and `/openapi.json` are left at their defaults, so anyone who loads the page gets the complete interactive catalogue of every route INCLUDING `/v1/keys`. And the 429 path pays four sorts of a 512-element deque, on the event loop, precisely when the box is already saturated.

## Evidence
- `service/app.py:1214` (`/health`) and `:1247` (`/metrics`) — no `dependencies=` on either.
- `service/engine.py:1035-1049` — `config()` returns workers, queue_max, torch threads, language, quantize and the full `tuning` dict; both endpoints return it.
- `service/app.py:82` — `FastAPI(...)` with no `docs_url=None`/`openapi_url=None`, so `/docs`, `/redoc`, `/openapi.json` are public.
- `service/app.py:298` — `_backpressure_response` calls `metrics.snapshot()`, which calls `_pct` four times (`engine.py:457-460`), each `sorted(data)` over a 512-deque (`engine.py:430`).

## Acceptance criteria
- `/health` keeps an UNAUTHENTICATED liveness answer — orchestrators and the studio's health poller depend on it — while the config/tuning detail moves behind auth.
- `/metrics` requires a scope when a key is configured, and behaves sensibly when one is not (local dev must still work).
- Interactive docs and the OpenAPI schema are disabled or gated when `TTS_API_KEY` is set.
- The 429 path stops recomputing percentiles; backpressure responses stay informative enough to be useful.
- Tests pin: `/health` liveness without auth, config NOT leaking unauthenticated, `/metrics` requiring auth, docs gated. (No test currently touches either endpoint's HTTP response at all.)

## Risks / non-goals
- Do not break the studio: `web/lib/useHealthPoll.ts` and the benchmarks view read `/api/health`, and the launcher aggregates `/metrics` — trace every consumer before changing a shape.
- Non-goal: a full auth redesign, or removing the open-by-default posture when `TTS_API_KEY` is empty (that is a separate product decision already flagged in the vault).

## Build record
Builder S2 (+ Director KEDA fix `005f574`). `/health` keeps an unauthenticated liveness answer (status + worker census); `config` and the latency percentiles now require `OBSERVABILITY_SCOPE = "tts"` — deliberately not `admin`, so a managed monitoring key is possible, and in open mode everyone holds it so local dev is unchanged. `/metrics` requires the scope when a key is set, with a loopback exemption (`TTS_METRICS_ALLOW_LOOPBACK`, default on) for the replica supervisor's stdlib aggregator. `docs_urls()` → `TTS_DOCS=auto|on|off`; auto publishes in open mode and turns `/docs`, `/redoc` and `/openapi.json` off as soon as a key is set. The 429 path now uses a new O(1) `Metrics.counters()` instead of `snapshot()`, and `snapshot()` sorts each window ONCE rather than once per percentile.

The builder traced and tabulated every consumer of `/health` and `/metrics` (helm readinessProbe, bootstrap/oneclick/cloudformation scripts, three benchmark scripts, `loadtest.py`, the replica aggregator, `useHealthPoll` via the Next proxy) and said what kept each working.

**Director-caught REGRESSION, fixed inline (`005f574`)**: the shipped Helm chart's KEDA ScaledObject polls `/metrics` from the KEDA operator pod over cluster DNS — neither authenticated nor loopback — so on any keyed deployment autoscaling would have started 401ing and stopped SILENTLY while every other probe kept passing. The builder flagged it precisely and correctly stayed inside its file scope. Director added a `TriggerAuthentication` bound to the chart's existing `TTS_API_KEY` secret and an `xi-api-key` header on the trigger; verified with `helm template` in keda mode and `helm lint`, and confirmed hpa mode unaffected.

**Accepted residual risk, recorded**: the loopback exemption means a same-host reverse proxy makes every request look local. Documented with an off switch; it exists so the launcher's credential-less aggregator keeps working. Worth revisiting if the deploy shape puts nginx on the box. Gates on main: 447 at merge, 469 after the wave. MERGED.
