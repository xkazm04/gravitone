# REPORT — AUDITION (Audition Room), Batch 1

> Saved by the orchestrator from the builder's inline report.

**Status: done.** voice-creation-studio M1 steps 1–3, contract C6.

Files (11): created `service/tests/test_audition.py`, `web/app/api/ingest/[job]/audition/route.ts`,
`web/app/voices/new/_state/audition.ts` + `.test.ts`, `_state/useAudition.ts`,
`_review/AuditionPanel.tsx`; modified `service/export_stems.py`, `service/ingest_api.py`,
`_state/machine.ts` + `machine.test.ts`, `page.tsx`.

Tests green: yes. Service gate 221 OK (test_audition = 32); export_stems consumers 136 OK;
py_compile clean; tsc clean; `vitest app/voices` 146 OK. Full vitest 324/325 — the one red is
`PlaygroundConsole.test.tsx` (SIGNAL's live surface, imports nothing of AUDITION's) → orchestrator
to resolve at integration.

C6: wav + `X-Audition-*` headers + no-store; 400/404/409/429/500 all named. Separate
`MAX_ACTIVE_AUDITIONS=2` budget so no job slot is consumed. Scratch voice rmtree'd on
success/failure/timeout + `_audition_` prefix GC sweep from `_gc_once`. No length gate (allow_short).

Recipes: `full` / `longest` / `confident` (skipped when confidences are equal) / `tightest`;
deterministic, deduped, only offered when ≥2 candidates differ; baseline starts from
`plan_baseline`; positional segment↔wav join verified; `outlier:"dropped"` segments excluded
(F-LOOP integration); index map stays server-side (`recipe_plan` not public). Commit re-splices to
the chosen recipe and reports `recipes.applied/skipped`.

UX: fast path byte-identical (audition is opt-in drill-down); "stem" vs "as a voice" clearly
labelled; blind X/Y with side-swap; votes undoable; failures amber + advisory.

Optional integration swaps: `<TakePlayer>` at the two `play(url,id)` call sites (props
`play`/`playing` are the seam); F-LOOP `stems[*].identity` displayed AFTER the vote.

Deferred: M1 step 4 (embedding cosine second opinion), step 6 (won/lost recipe stats),
warm-child reuse for cheaper auditions.
