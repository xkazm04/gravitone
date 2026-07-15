# Dual-lens scan — web-benchmarks-health
> Files: 5 | Findings: 5 (crit 0 / high 2 / med 3 / low 0)
> Lenses: bug-hunter + code-refactor

## 1. Capacity planner recommends the pricier box and contradicts its own leaderboard
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: correctness / money-truth
- **File**: `web/lib/benchmarks.ts:122`
- **Scenario**: Default planner inputs (streams=4, dailyMin=600) give `need=4`. `single` filters `buyable` to boxes whose *single-instance* capacity ≥ need — that excludes `t4g.small` (cap 1.33) and selects `c8g.2xlarge`. Result: **1× c8g at $211.9/mo**. But `4× t4g.small` also covers need=4 (cap 5.32) at **$49/mo** — 4.3× cheaper.
- **Root cause**: The selection heuristic ("smallest box that covers need in ONE instance") minimizes instance count / hourly price among single-covering boxes, and only horizontally scales the *highest-capacity* box when nothing covers alone. It never compares a horizontal fleet of a cheaper box against a single pricier box, so it ignores total monthly cost.
- **Impact**: The planner — the page's headline "turns your volume into an exact instance + env config" feature — recommends a config several× more expensive than optimal, and directly contradicts the leaderboard on the same page, which ranks `t4g.small` ($0.0126/audio-h) as *cheaper per audio-hour* than `c8g` ($0.0266/audio-h). Undermines the whole "measured $/audio-hour" trust thesis.
- **Fix sketch**: Enumerate every buyable box, compute `instances = ceil(need / capacity)` and `monthlyUsd = instances * usdPerHour * HOURS_PER_MONTH` for each, then pick the box+instance-count with the lowest total monthly cost (tie-break on fewer instances). Keep the "GIL-bound, scale by process" note as the config output, not the selection rule.

## 2. Unauthenticated, key-attaching TTS proxy with unbounded body and 180s hold
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: trust-boundary / missing-auth
- **File**: `web/app/api/performance/route.ts:23`
- **Scenario**: There is no `middleware.ts` and no auth check in the route. Anyone who can reach the deployment (the `/benchmarks` page is explicitly a public proof asset in the same app) can `POST /api/performance` with an arbitrary body; `backend.ts:12` then attaches the operator's root `GRAVITONE_API_KEY` and forwards to the key-protected backend `/v1/performance`. The whole request body is read with `await req.text()` (no size cap) and the upstream call is held up to 180s.
- **Root cause**: The proxy design keeps the key server-side but places no auth, rate-limit, or size bound in front of it, so the studio becomes an open relay that launders anonymous traffic through the privileged key — defeating the very key protection the backend enforces. Sibling `web/app/api/speak/route.ts` has the identical exposure (systemic).
- **Impact**: Free/anonymous use of the paid backend at the operator's expense, capacity exhaustion (each request can pin a connection for 180s and buffer an arbitrarily large body in memory), and effective bypass of backend key auth.
- **Fix sketch**: Gate `/api/*` proxy routes behind session/API-key auth (or a shared secret + per-IP rate limit) in `middleware.ts`; enforce a max request-body size before forwarding; consider a shorter timeout with an explicit 504.

## 3. `performance/route.ts` is a near-verbatim clone of `speak/route.ts`
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `web/app/api/performance/route.ts:20`
- **Scenario**: `performance/route.ts` and `web/app/api/speak/route.ts` are byte-for-byte identical except for the backend path (`/v1/performance` vs `/v1/speak`) and the `FORWARD_HEADERS` list (`X-Performance-Report` vs `X-Segments`): same try/`backendFetch`/catch-503 skeleton, same non-ok `Retry-After` passthrough, same ok `arrayBuffer` + header-forward tail, same 180s timeout.
- **Root cause**: Copy-paste of a proxy skeleton instead of a shared helper. Any hardening (see finding 2 — size cap, auth, timeout tuning) must now be applied in two places and will drift.
- **Impact**: Divergence risk on the security-sensitive proxy path; double the surface for the finding-2 fix.
- **Fix sketch**: Add `proxyWav(req, backendPath, forwardHeaders)` to `web/lib/backend.ts` encapsulating the try/catch/status/header-forward logic; both routes become one-liners passing their path + header allowlist.

## 4. ElevenLabs tier-pricing + `HOURS_PER_MONTH` duplicated with divergent extrapolation
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `web/lib/benchmarks.ts:134`
- **Scenario**: `HOURS_PER_MONTH = 730` is declared in both `benchmarks.ts:110` and `switchkit.ts:35`. The "cheapest covering tier, else extrapolate past the top tier" logic exists twice: `switchkit.ts:52-59` (`estimateMonthly`) extrapolates as `(chars / elTier.charsPerMonth) * elTier.usdPerMonth`, while `benchmarks.ts:135-141` (`planCapacity`) extrapolates as `(monthlyChars / last.charsPerMonth) * last.usdPerMonth` and additionally special-cases `monthlyChars <= 0 → null`. The two implementations of "what does this volume cost at ElevenLabs" can return different numbers for the same input.
- **Root cause**: Two features (SwitchKit estimator, benchmarks planner) each re-derived EL pricing instead of sharing one function, so their math has already drifted.
- **Impact**: Inconsistent EL cost figures across the app for identical volumes; a pricing-tier change must be edited in two subtly different places.
- **Fix sketch**: Export a single `elCostForChars(chars: number): number | null` from `switchkit.ts` (the pricing home) and have `planCapacity` call it; import the shared `HOURS_PER_MONTH` from one module.

## 5. Planner degrades to one process + spare-vCPU torch threads for `t4g.small`, violating its own scaling law
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: edge-case / correctness
- **File**: `web/lib/benchmarks.ts:128`
- **Scenario**: Slider values with `need` in ~[0.1, 1.33] (e.g. streams=1, dailyMin=0) select `t4g.small`, whose `processes` field is `null` (only single-stream was measured). Then `processesPerBox = box.processes ?? 1 = 1` and `torchThreads = floor(vcpu/1) = floor(2/1) = 2`. The emitted plan (`planEnvBlock`) recommends **1 single-worker process with `TTS_TORCH_THREADS=2`** on a 2-vCPU box.
- **Root cause**: The `?? 1` fallback for a box with unknown process-scaling collapses multi-process planning to a single process and hands the remaining vCPU(s) to torch threads — directly contradicting the planner's stated law ("run single-worker processes, not in-process threads … the model is GIL-bound", benchmarks.ts:11 / BenchmarksView.tsx:178-180). Under that law the second vCPU yields ~no throughput as configured.
- **Impact**: For the low end (the exact hobbyist case the planner targets), the recommended config under-utilizes the box and prescribes threads the page itself says are useless, so the box is effectively sized to ~1 stream while advertised at 1.33×. (`planEnvBlock` also prints "run 1 processes per box" — plural agreement — a cosmetic tell of the same path.)
- **Fix sketch**: Default `processesPerBox` for process-scaling-unknown boxes to something like `max(1, floor(vcpu / 2))` (one process per ~2 vCPU) with 1 torch thread each, or explicitly measure and populate `processes`/`multiProcessAudPerS` for `t4g.small`; never allocate >1 torch thread while claiming GIL-bound single-worker scaling.
