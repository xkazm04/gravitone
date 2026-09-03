---
slug: shared-limits-that-tell-the-truth
type: perfect/direction
context: "[[concurrency-engine-metrics]]"
lens: robustness
status: shipped
size: M
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: 13bc43e
---
## What & why
Public-compute limits are fiction at fleet scale: per-process in-memory buckets mean N replicas = N× the budget the 429 states as fact; enabling the router inverts it (no X-Forwarded-For forwarded → one global bucket for the whole internet). `/v1/speak`, `/v1/performance`, and the 25 MB anonymous `POST /v1/takes` have NO budget while the drop-in route got one in batch 7. The public metrics server re-publishes on 0.0.0.0 the capacity + voice-map detail the admin server deliberately binds to loopback. RePerform's copy claims "per visitor" on a default deploy where it is per-deployment.

## Evidence
- ratelimit.py:66 per-process; :197-200 429 states single budget; :134-150 client_ip vs TTS_TRUST_PROXY (:49 default 0)
- replicas.py:1048-1051 proxy strips/never adds XFF; :938-944 loopback rationale vs :1266 0.0.0.0 metrics server serving /pool + /introspect
- app.py:1201-1207 budget precedent; :2148 speak, :2284 performance, :2099 takes router unbudgeted (verified 2026-08-04)
- web RePerform.tsx:140-142 "per visitor" copy; t/[id]/reperform/route.ts:29-32

## Acceptance criteria
- Cross-process-honest limiting: file-backed shared bucket via atomicio (buildstore precedent) or per-replica budget division — builder recommends, Director decides; 429 body states the REAL effective budget.
- Router forwards X-Forwarded-For (and TTS_TRUST_PROXY story documented) so router-mode keeps per-caller buckets.
- Budgets on /v1/speak, /v1/performance, takes upload (sized like DEMO_TTS_BUDGET; env-tunable).
- /introspect-grade detail (per-replica capacity, voice map) no longer served unauthenticated on the public bind.
- RePerform copy matches shipped reality.
- Multi-process tests (test_file_lock.py precedent).

## Risks / non-goals
- Budgets must not break the studio's own proxied traffic (server key attaches server-side; pick limits that clear normal studio use).
- Small pre-authorized web copy change (RePerform.tsx).

## Build record
(pending)
