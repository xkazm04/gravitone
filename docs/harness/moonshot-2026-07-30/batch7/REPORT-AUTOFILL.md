# REPORT — AUTOFILL (Algebra continuation), Batch 7

> Saved by the orchestrator from the builder's inline report.

**Status: done, all gates green.**

Files: `service/tools/derive_autofill.py` (demand-ranked, one slot/character, named cap
AUTOFILL_CAP/GRAVITONE_AUTOFILL_CAP/--cap, --dry-run, deterministic, derives through
voices.derive_emotion itself, reversible via the ordinary delete); `service/tools/derive_ab.py`
(blind A/B, per-field "noticeable step" distance, excess-based quality, median across
speakers, in_sample published, engine required + named absent); `service/emotion_basis.py`
(versioned `transfer` block + write_transfer merge + transfer_gate; a rebuild drops stale
measurements); `service/voices.py` (basis-path quality refusal; derived_from.transfer
carries the number or state:"unmeasured"); `service/packs.py` — **BUG CONFIRMED AND FIXED**:
origin/derived_from/fidelity/prosody were dropped on export; import now carries them and a
derived slot can never arrive "recorded" (consent-laundering guard).

Tests: test_derive_autofill 30, test_derive_ab 40, test_pack_origin 14, + transfer-gate
cases in test_emotion_derive; gate set 296 OK; py_compile OK.

Hook (handled by orchestrator): LIMITER's DEMO_* budgets are process-global, so suites
making >20 POSTs hit 429 (test_verify 5, test_compat 2). Fix = ratelimit.reset_all() per
test in the affected suites (AUTOFILL already did its own).
