# Dual-scan Fix Wave 6 — Money-truth / sizing-truth

> 4 commits, 9 findings closed (1 high, 7 medium, 1 low).
> Gates: web `tsc` 0 / `next build` PASS; `test_loadtest` 36/36; **every number change proven by a runnable smoke** (money math via tsx, advisor logic via unittest).
>
> Theme: **every figure the product displays must be true** — pricing claims (web) and capacity claims (loadtest advisor).

## Commits

| # | Commit | Findings | Severity | File(s) |
|---|---|---|---|---|
| 1 | `ef34bbf` | planner picks pricier box; EL pricing duplicated; thread config violates own law | high + 2 medium | `lib/benchmarks.ts`, `lib/switchkit.ts` |
| 2 | `cd918b7` | savings clamped to $0 hides a loss | medium | `lib/switchkit.ts`, `variants/SwitchKit.tsx` |
| 3 | `85f430e` | lifetime audio priced at a monthly tier | medium | `ui/SavingsTicker.tsx` |
| 4 | `f16cb86` | advisor sizes from degraded/all-failed runs (×3) + dead import | 3 medium + 1 low | `service/loadtest.py` |

## What was fixed — with the numbers

**1. The planner recommended a 4.3× overcharge.** The rule was "cheapest box that covers `need` in ONE instance"; it never compared a horizontal fleet of a cheap box against a single pricey one. It now minimizes **total monthly cost** across every buyable box.

| | before | after |
|---|---|---|
| need = 4 (default inputs) | 1× c8g.2xlarge — **$211.90/mo** | 4× t4g.small — **$49.06/mo** |

This also stops the planner contradicting the leaderboard *on the same page*, which already ranked t4g.small cheapest per audio-hour.

**2. The savings pill hid real losses.** `Math.max(0, elUsd - boxUsd)` clamped the unfavorable direction, so an always-on box that costs more than the tier rendered an emerald "you keep $0.00".

| 30k chars/mo | before | after |
|---|---|---|
| EL $5.00 vs box $12.26 | "you keep **$0.00**" (emerald) | "costs more at this volume · **+$7.26**/mo" (amber) + "pays off above ~100,000 chars/mo" |

**3. Lifetime audio was priced as a monthly subscription.** `audio_seconds_total` is cumulative; feeding it to the monthly-tier estimator compared two different time spans — wrong in *both* directions:

| lifetime volume | before (monthly tier) | after (marginal $/char) |
|---|---|---|
| 10 audio-min | **$0.00** (fits the Free tier!) | $1.20 |
| 1,000 audio-min | **$330** (a Scale *subscription*) | $120 |

**4. The sizing advisor lied in three ways** (its output feeds the hardware certificate *and* the web planner):
- **Baseline-degraded → recommended the worst level.** When the first level already degrades there's no safe cap; `or rows[-1]` silently sized from the *highest, most degraded* concurrency — the opposite of safe, in the exact scenario the tool exists to catch. Now fails closed to the smallest level with a loud warning.
- **All-501 runs reported "no degradation".** `unsupported_501` was a bucket the degradation predicate never read, so a 100%-failed stream run (ok=0, no p95) looked identical to a healthy one and emitted a confident cap.
- **The CPU gate blamed the server for the driver's load.** The module carefully separates server CPU from driver CPU, then made the verdict on the *whole-host* figure — a co-located load generator could trip a false knee and understate real capacity.

**5. Single pricing source.** `planCapacity` re-implemented the "cheapest covering tier, else extrapolate" math that `estimateMonthly` already had (with a divergent extrapolation), and `HOURS_PER_MONTH` was declared twice. `switchkit.ts` is now the pricing home (`elTierFor` / `elCostForChars` / `HOURS_PER_MONTH`); planner and estimator now agree exactly across tiers.

**6. Thread config contradicted the page's own law.** An unmeasured box fell back to `processes ?? 1` — collapsing to one process and handing the spare vCPU to torch threads, which the page itself says buys ~nothing (GIL-bound). Unmeasured boxes now get one process per ~2 vCPU with **1** torch thread; `processesPerBox` rides on the `Plan` so `planEnvBlock` stops re-deriving it (fixing its "1 processes" plural tell).

## Verification

| Gate | Result |
|---|---|
| web `tsc --noEmit` / `next build` | 0 errors / PASS |
| `service.tests.test_loadtest` | 36/36 |
| money-math smoke (tsx) | planner $49.06 ✓ · savings −7.26 ✓ · lifetime $1.20/$120 ✓ · planner==estimator ✓ |
| advisor smoke | all-501 degrades ✓ · host-hot/server-cool does NOT ✓ · server-saturated does ✓ · no-split falls back ✓ · baseline-degraded warns + sizes conc=1 ✓ |

**Verify-before-fix note:** checked `test_loadtest` first to confirm no existing test enshrined the old behavior — the CPU tests carry no `server_cpu_mean_pct`, so they exercise the fallback and stayed green. (A prior scan's tests *can* encode a bug; worth the 30 seconds.)

## Patterns established (catalogue items 25–29)

25. **Optimize the number the user actually pays, not a proxy.** "Smallest/cheapest unit that covers the need" ignores total cost — enumerate the options and minimize the real bill. (planner)
26. **Never clamp a signed comparison to hide the unfavorable direction.** `max(0, savings)` turns a loss into a green "$0 kept" that contradicts the raw numbers beside it. Carry the sign; let the UI render it. (switchkit)
27. **A cumulative counter and a subscription price cover different time spans.** Price a lifetime total at a marginal rate; never feed it to a monthly-tier estimator. (SavingsTicker)
28. **An advisor with no valid answer must fail closed to the safest option**, never fall back to the last/worst element of a list. (print_plan)
29. **Wire every distinct failure bucket into the verdict predicate** (or a 100%-failed run looks healthy), and **make the verdict on the honest measurement**, not just report it (server CPU vs host CPU). (level_degraded)

## What remains (per INDEX)

Waves left: test integrity (Wave 8), dead-code/duplication (Wave 9). Plus the standing defers: ingest commit/GC lifecycle trio, keys.py event-loop cache, `app.py` streaming-errors-swallowed, takes/voices atomic-write sweep, and the web-UX/a11y tail (character-api #3/#4, shell-landing #3/#5).

Note: **`web-api-keys #3`** (migration compatibility check never uses the minted key → false-positive "compatibility passed") is money-adjacent success-theater but sits in the keys UI; it's folded into the test-integrity/tail work rather than this pricing wave.
