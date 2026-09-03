---
slug: honest-self-reported-numbers
type: perfect/direction
context: "[[Speech Synthesis API]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 2b84ae1
---
## What & why
Two of the service's own self-reported numbers are false. `/v1/speak` and `/v1/performance` compute `X-Synth-Seconds` by SUMMING segments that ran concurrently — a duration that never elapsed, and a realtime factor that never existed. Round 4 fixed precisely this on the drop-in route, and round 5 widened the gap: at the shipped `workers=1` the drop-in route is single-job and honest by construction while these two remain multi-job and wrong. Separately, `Metrics.on_cache_hit` and `on_collapsed` have ZERO production callers, so `/metrics` reports `cache_hits: 0` and `collapsed: 0` forever — and `replicas.AGG_KEYS` now dutifully sums those structurally-zero fields across the pool.

## Evidence
- `service/app.py:1105` — `total_synth += result.synth_seconds`; header at `:1117`, RTF at `:1112`. Identical at `:1193`, `:1201`, `:1206` for `/v1/performance`. (Director-verified.)
- `service/app.py:778` — the drop-in route uses wall-clock; pinned by `service/tests/test_longform.py:328`. No equivalent test exists for speak/performance, which is why the bug survived.
- `service/engine.py:352,364` — `on_cache_hit` / `on_collapsed` defined; `grep` finds NO production caller, only `service/tests/test_admission_accounting.py:93-95`. (Director-verified.)
- `service/engine.py:355-358` — the docstring states these exist so `received` counts cache-served requests; it does not.
- `service/replicas.py:76-79` — `AGG_KEYS` includes both, so the pool aggregate sums zeros.
- Neither route emits `X-Cache`, `X-Queue-Seconds` or `X-Synth-Segments` (`app.py:1113-1121`, `:1202-1210`).

## Acceptance criteria
- `/v1/speak` and `/v1/performance` report wall-clock synthesis time, with RTF derived from it; pinned by tests modelled on `test_longform.py:328`.
- `on_cache_hit` / `on_collapsed` are called on the real cache path, so `received` once again counts every request the service served.
- A test asserts an HTTP cache hit increments the counter — the absence of exactly this test is why the dead callers went unnoticed.
- Header parity: the diagnostics available on the drop-in route are available on these two where they apply.
- `AGG_KEYS` contains no field that is structurally zero.

## Risks / non-goals
- **Director's own miss, recorded**: round 5's ownership split (E-A owned `engine.py` counters, E-B owned the cache call site and was forbidden `engine.py`) created this gap, and the review verified the counters EXISTED rather than that anything called them. Check wiring, not just presence.
- Non-goal: new metrics surfaces, dashboards or per-route/per-voice breakdowns — an earlier round rejected `one-truth-metrics`. This is making existing numbers true, not adding numbers.

## Build record
Builder S1. `/v1/speak` and `/v1/performance` now report WALL-CLOCK synthesis time (submit → concat, the same span the drop-in route measures) with `X-Realtime-Factor` derived from it; the summed-concurrent-segments number is gone. Header parity where it applies: `X-Queue-Seconds` (worst segment's admission wait) and `X-Synth-Segments`. Deliberately NO `X-Cache` — neither route is cached and a header that always said "miss" is noise, stated in both docstrings. `on_cache_hit`/`on_collapsed` wired at the drop-in route's cache call site (in `app.py`, not `engine.py`), classifying hit-vs-collapse by which `SynthCache` counter moved; the builder documented the one imprecision honestly (two identical requests resolving in the same await window can swap the two labels between themselves — their sum and `received` are exact either way).

**The generalising move**: `AGG_KEYS` needed no change, and the builder proved it rather than assuming — via a new test that walks every key and **fails on any field with no production writer**. That is a test against the bug CLASS. Its cache-hit test drives real HTTP (`TestClient` + `asyncio.gather`) rather than poking `Metrics`, because the absence of exactly that assertion is why the dead callers survived a round.

**Director's own miss, closed**: round 5's ownership split gave the counters to one builder and the cache call site to another, and the review verified the counters EXISTED rather than that anything called them. Lesson recorded in config.md: check wiring, not presence. Gates on main: 469 + 72 subtests. MERGED.
