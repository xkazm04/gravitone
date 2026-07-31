# REPORT — LIMITER (Rate limiter + Public Re-perform), Batch 7

> Saved by the orchestrator from the builder's inline report. app.py patch + /t page diff
> applied by the orchestrator (composed with LANES' TakeScore).

**Status: complete, gates green.**

Files — new: `service/ratelimit.py` (fixed-window+burst per-IP, monotonic injectable clock,
LRU-bounded, TTS_TRUST_PROXY-gated XFF, named 429 + Retry-After, per_ip_budget factory),
test_ratelimit.py, `web/app/t/[id]/RePerform.tsx` (+test), `web/app/t/[id]/reperform/route.ts`
(proxy, caps body, forwards XFF). Edited: `service/takes.py` (allow_reperform publish flag
default OFF, _build_record/_write_take shared with POST /v1/takes/{id}/reperform,
speak-provider seam, child = leaf + derived_from {kind:"public-reperform"}, direction delta,
REPERFORM_BUDGET 5/300s burst 2), test_takes_reviews (+12), web/lib/takes.ts,
engine.ts uploadTake(t,{allowReperform}), PlaygroundConsole (3-line toggle).

Tests: ratelimit/takes_reviews/direction/private_surface 87/87; py_compile OK; tsc clean;
vitest 867/867 (first run hit the tracked flake; green on rerun).

app.py patch (applied by orchestrator): per_ip_budget imports; DEMO_TTS_BUDGET (60/60s
burst 6) on the drop-in TTS route; DEMO_CLONE_BUDGET (20/600s burst 4, POST-only) on the
voices router; `_speak_for_take` provider handed to takes_plane (takes.py cannot import
app.py — same seam as convai.set_engine_provider).

/t page (applied, composed with LANES): ReperformProvenance + RePerform after Lineage,
TakeScore after the TakeCard wrapper.

Hooks: none.
