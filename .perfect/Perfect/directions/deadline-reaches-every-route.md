---
slug: deadline-reaches-every-route
type: perfect/direction
context: "[[concurrency-engine-metrics]]"
lens: robustness
status: shipped
size: M
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: 0b75c50
---
## What & why
`deadline_s`/`degrade_allowed` reach the engine from exactly one branch: the single-unit path of `/v1/text-to-speech`. The multi-unit branch of the SAME endpoint, `/v1/speak`, `/v1/performance`, streaming, and `/v1/build` silently drop them — the deadline contract is honored or ignored depending on text length. Separately, `deadline_s` is an unauthenticated priority knob: `0.001` outranks every interactive job with no achievability check.

## Evidence
- app.py:1030-1035 single-unit threads deadline; :1051 `_submit_batch` drops it; :400-458 speak/performance waves drop it; :1961 build drops it
- engine.py:1324-1325 priority uses raw deadline; :82-88 aging bound bypassed by explicit deadlines

## Acceptance criteria
- deadline_s/degrade_allowed thread through multi-unit drop-in, /v1/speak, /v1/performance, streaming, /v1/build submissions.
- Explicit deadlines clamped/floored so they cannot starve the interactive class (e.g. floor at a class-minimum effective key).
- Per-route tests asserting the contract is LIVE (deadline actually alters ordering/degrade on each route).
- Multi-unit requests share one deadline sensibly (documented choice).

## Risks / non-goals
- Non-goal: distributed deadline across replicas.
- Coordinate with [[promises-are-measured]] (same engine.py regions) — same builder.

## Build record
(pending)
Build record: E1 done. Route tests behavioural (fake pool keyed by production _priority). Multi-unit semantics: whole-horizon inheritance, remaining-horizon on later waves/segments, /v1/build per-line + degrade_allowed 400 (digest law). Class-floored queue keys stop priority buying. Merged 0b75c50, 69 targeted tests green on main.
