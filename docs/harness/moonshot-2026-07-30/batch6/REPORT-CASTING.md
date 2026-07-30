# REPORT — CASTING (Segment Casting Board), Batch 6

> Saved by the orchestrator from the builder's inline report.

**Status: H3 complete** — all three steps shipped.

Service — `ingest_api.py`: GET /v1/ingest/{job}/segment/{i} (speaker-preview sibling, four
named 404s); POST /v1/ingest/{job}/stems {assignments, reset} — validates against this
scan's own segments, re-splices only CHANGED emotions via concat_wavs, returns measured
seconds/eligibility/note/assigned/proposed/takes; workdir-only, no roster write, no job
slot, idempotent (2nd identical body → changed: []). `_board()` re-derives the pipeline's
proposal (incl. plan_baseline's borrow ORDER) so reset is exact; published on the ledger as
`casting`. Editing a row WITHDRAWS its audition recipes (+ wavs) so /audition hears the new
stem and a stale pick is named at commit; reset rebuilds them. `ingest.py`: segments publish
i + ok (corpus layer untouched).

Web — machine.ts (+Segment/CastStem/CastResult, assignments/dirty, CAST_SEGMENTS/
CAST_SYNCED; batch-2 tests unchanged), new _state/casting.ts + useCasting.ts (450ms
debounce, coalesced, named refusals), _review/SegmentBoard.tsx (TakePlayer compact per
segment incl. rejected, chips/badges, LIVE seconds bar + clonable badge, always-visible
reset), row expands on segment count; segment/[index] + /stems proxies.

Tests: test_casting (30) + 243 service green (all ingest_* + corpus + audition +
private_surface); py_compile OK; tsc clean; vitest 822/822 (flake passed). 

Notes: pooling seam deliberately unbuilt — batch-5 corpus capture copies stem_*.wav + result
stems, so a re-cast stem is captured coherently (the seam is ready). Ownership note:
web/app/api/ingest/** wasn't in any batch-6 column; CASTING added two proxy files there
(no other builder touches it) — accepted.
