# REPORT — REMIX (Re-performable Takes), Batch 5

> Saved by the orchestrator from the builder's inline report. Both hooks applied by the
> orchestrator (direction router in app.py; engine.ts uploadTake lineage), plus the
> serviceHeaders mirror for DEADLINE's X-Gravitone-Deadline / X-Quality-Level.

**Status: G5 complete.**

Files — service: `takes.py` (parent_id + derived_from on create, GET /v1/takes/{id}/lineage,
leaf-first _evict_oldest, POST /v1/reviews/{id}/revise + revisions on get_review), new
`direction.py` (record_delta/stats + /v1/direction/stats router), test_takes_reviews (+22),
new test_direction. Web: lib/takes.ts (+lineage types/loadLineage) + lib/takes.test.ts;
app/t/[id]/{page.tsx, Lineage.tsx (new), OpenInRack.tsx (new) + test};
app/r/[id]/{ReviewPicker.tsx, actions.ts (new)}.

Gates: test_takes_reviews 28/28, test_direction 9/9, private_surface green; py_compile OK;
tsc clean; vitest 649/650 (the 1 = serviceHeaders drift gate catching DEADLINE's header —
fixed by orchestrator at integration). PlaygroundConsole passed.

Applied hooks:
1. app.py: direction_router included under tts scope beside reviews_router.
2. engine.ts uploadTake: sessionStorage `gravitone.remix.parent` → parent_id + derived_from
   {kind: "remix"} on publish (fork works without it; child publishes linked with it).

Deferred (per design): public re-perform + shared per-IP rate limiter (hero-demo hardening
pass); direction stats surfaced in studio coverage UI.
