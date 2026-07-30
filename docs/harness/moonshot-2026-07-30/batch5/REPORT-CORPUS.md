# REPORT — CORPUS (Voice Corpus), Batch 5

> Saved by the orchestrator from the builder's inline report.

**Status: G4 complete.** Files: `service/ingest.py` (+corpus layer ~600 lines),
`service/ingest_api.py` (routes + capture wiring), `service/config.py` (corpus_dir,
corpus_max_bytes, corpus_stem_seconds), new `service/tests/test_corpus.py` (34).

Shipped: opt-in `corpus` on scan+commit (default OFF — sovereignty first; commit wins);
capture COPIES used segment wavs, labels/confidences/cues/failures/outlier flags, stems,
Levels, clip hash, consent receipt into corpus_dir/<cid>/<clip_sha>/; versioned corpus.json
(newer schema refused); re-ingest = no-op; cross-process locked; byte cap with named pruning
(unmeasured → lowest identity → oldest; last clip never pruned). GET
/v1/characters/{id}/corpus (itemized) + DELETE .../corpus/{sha} (reports what went). POST
/v1/ingest/rederive = background job, best-of (fidelity only when EVERY candidate measured,
else duration×confidence), re-exports via commit(replace=True) stamping derived_from
{corpus_rev, dsp_version, model_version, clips, basis}; 404/409 refusals synchronous.
Rederive deliberately does NOT roll back (rollback would delete the replaced original too).

Tests: test_corpus 34 + all test_ingest_* + test_audition + test_private_surface = 213 OK;
full suite 1480 OK; py_compile clean.

Hooks: none. Structural note: ingest_api.router is now UNPREFIXED with full paths written
out (INGEST + "/..."), so the /v1/characters/{id}/corpus family rides the existing app.py
mount; external paths byte-identical.

Deferred (per design): .gravichar corpus portability (step 6).
