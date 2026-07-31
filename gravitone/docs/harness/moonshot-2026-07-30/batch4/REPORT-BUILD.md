# REPORT — BUILD (Speech as a Build Artifact), Batch 4

> Saved by the orchestrator from the builder's inline report. Builder was interrupted by the
> weekly API limit mid-flight and resumed from transcript after reset — completed cleanly.

**Status: F2 complete + ENGINE-PLANE wiring.**

Files: `service/buildstore.py` (new: DIGEST LAW constants, speech_digest, normalize_text,
parse_digest/etag_matches, BuildStore — atomicio atomic writes + cross-process file_lock,
sharded layout, named GRAVITONE_BUILD_STORE_BYTES budget, LRU-by-use prune, named 404);
`service/app.py` (X-Speech-Digest + ETag on the drop-in route, If-None-Match → 304 BEFORE
any synthesis, artifact publish, GET/HEAD /v1/audio/{digest}, POST /v1/build + /v1/build/plan,
_render_tts(resolved=…) so resolution isn't doubled, engines router include +
set_pool_provider); `service/tests/test_buildstore.py` (new, 35 incl. 4 golden pinned
digests); one additive line in service/tests/__init__.py pointing the store at a temp dir so
suites stop writing into the checkout.

Tests: full service suite 1288 OK (5 skipped) incl. all gate modules + engine_conformance;
py_compile clean. Plain-TTS and build-line digests PROVEN equal.

Deferred: gravitone.lock emission, zip delivery, CLI/GitHub-Action client, pooled/S3 backend.

Hooks: `build_store/` added to .gitignore by the orchestrator (outside builder ownership).
Orchestrator also mirrors ETag/X-Speech-Digest into web/lib/serviceHeaders.ts (drift gate
caught it, as designed).
