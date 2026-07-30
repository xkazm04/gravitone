# REPORT — LOCKFILE (gravitone.lock + build client), Batch 7

> Saved by the orchestrator from the builder's inline report.

**Status: I2 complete, all gates green.**

Files: `service/buildstore.py` (build_id/parse_build_id, lockfile() + documented schema
`gravitone.lock/1` + lockfile_bytes, zip_member_names traversal-safe, stream_zip
one-member-at-a-time non-seekable ZIP_STORED with fixed epoch = byte-identical archives,
build-record store capped by count, named BUILD_NOT_FOUND/BUILD_PRUNED/ZIP_TOO_LARGE/
DUPLICATE_LINE_ID, GRAVITONE_BUILD_ZIP_MAX_BYTES); `service/app.py` build routes only
(POST /v1/build/lock, GET /v1/build/{build_id}.zip — 400/404/410/413 all pre-stream, no
re-render; build_id added to /v1/build + plan bodies, record persisted);
test_buildstore 35→62; `scripts/gravitone-build.mjs` + .test.mjs (23);
`.github/workflows/audio-drift.yml.example` (explicitly an example, not active).

Tests: buildstore 62, compat 22, verify 39, handler_modes 4, private_surface 21, auth 8,
cache 26 — all OK. Golden digests UNCHANGED. py_compile clean. node --test 23/23.

No new response headers (serviceHeaders untouched). Hooks: none.
Untested live: the CLI against a real running service.
