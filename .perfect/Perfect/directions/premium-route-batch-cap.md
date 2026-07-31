---
slug: premium-route-batch-cap
type: perfect/direction
context: "[[Speech Synthesis API]]"
lens: robustness
status: shipped
size: S
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: da365e5
---
## What & why
`/v1/performance` accepts 64 lines, each expanding into N metatag segments, and submits every one at once with no cap — against an admission window of `workers + queue_max` = 33 by default. So a long ensemble script is rejected by construction, and the failure scales with exactly the input the feature exists to showcase. Round 5 gave the drop-in route a principled cap derived from real parallelism and gave the product's differentiating route nothing.

## Evidence
- `service/app.py:1133` — `PerformanceRequest.lines` allows 64; each line's metatags expand further via `parse_segments`.
- `service/app.py:1091` and `:1180` — `_submit_batch(...)` called with no cap equivalent to `_max_batch_units()`.
- `service/app.py:479-514` — `_max_batch_units()`, the round-5 cap, is passed ONLY by the drop-in route.
- `service/config.py:59,62` — `workers=1`, `queue_max=32` → 33 admission slots.
- No test submits enough lines/segments to exceed the window, so this is unpinned.

## Acceptance criteria
- Speak and performance bound their submission the same way the drop-in route does — derived from real parallelism, not from queue depth.
- A 64-line script with metatag segments completes under default config; regression test.
- When the engine genuinely IS saturated the whole-batch 429 + `Retry-After` + sibling-abandon contract is unchanged.
- Segment ordering and the concatenated output are byte-identical to today for scripts that already fit.

## Risks / non-goals
- Reuse `_max_batch_units`/`_chunk_text`'s reasoning rather than inventing a second cap policy — two different answers to "how many units may one request submit" would be worse than the current one.
- Non-goal: changing the 64-line limit or the metatag grammar.

## Build record
Builder S1 (+ Director test fix `a018556`). New `_submit_and_gather_in_waves` bounds both premium routes by `_max_batch_units()` — the drop-in route's existing policy, derived from `SETTINGS.workers`, not queue depth. No second cap policy invented, as briefed. The key insight the builder brought: where `_chunk_text` MERGES past the cap, performance segments CANNOT merge (each names the voice that speaks it), so the script goes out in successive waves instead. A script that already fits is exactly one wave, so the previous call sequence is unchanged. Regression: 64 lines × 3 segments = 192 jobs completes under the default `workers=1, queue_max=32` — previously a 429 by construction — with all 192 present, ordered and unmerged.

Four pre-existing `test_parallel` cases were written against all-at-once submission on an implicit 1-worker box; they now declare the multi-worker topology they actually mean, the same hygiene fix round 5 applied to `test_longform`.

**Director-caught FLAKE, fixed inline (`a018556`)**: the new `test_bound_follows_workers_not_queue_depth` gave `FakeEngine` a capacity exactly EQUAL to the wave size, so the next wave raced the previous wave's permit release on the fake's worker threads — roughly one failure in eight at file scope, while the code under test was correct. Caught because the full-suite run came back red once and I refused to commit a staged change on top of an unread failure; characterised by looping the file (passes alone, passes in the full suite, fails at file scope) rather than dismissing it as noise. capacity 2 → 3, with a **teeth check**: restoring the old queue-derived cap still fails the test, so the extra slot does not weaken what it pins. 15 consecutive file-level runs green.

Open risk the builder flagged: a late 429 on wave 3 means waves 1-2 already rendered — finished audio rather than a burning slot, the same trade the streaming route's rolling window makes. Gates on main: 469 + 72 subtests. MERGED.
