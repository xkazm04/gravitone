---
date: 2026-07-26
slug: auth-coverage
status: shipped
type: weak-pattern
reach: "auth.py (all 401 paths, 0→8 tests) / packs.py + takes.py (~20 raises, 0→9 tests) / 1 500→404 fix"
risk: 2
effort: m
payoff: 4
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-error-handling]]"
---

# Auth structurally untestable; packs/takes zero tests; invalid voice → 500

## Context
`tests/__init__.py` pins `TTS_API_KEY=""` (open mode) package-wide, making every
401 path in `auth.py` unreachable by tests — a regression that silently opened
the service would fail nothing. `packs.py` and `takes.py` had zero tests.
A typo'd voice id fell through `engine._voice_state` to a model load whose
exception surfaced as a sanitized 500, uncached, re-entering model load on
every client retry.

## Decision
- `test_auth.py`: rebind `auth.SETTINGS` (frozen dataclass — replace, not
  mutate) + stub `auth.validate_key`; env pin untouched, so the rest of the
  suite stays open-mode. Covers: missing/wrong key 401, root via xi-api-key and
  Bearer, managed-key scope pass, managed-key-never-admin, root-opens-admin,
  GET/write scope split.
- `test_takes_reviews.py`: takes 400s/404, review-of-unknown-take 404,
  first-pick-wins (400/200/409), preferred-empty shape, pack import bad-zip /
  no-manifest 400s, export-unknown 404. Store dirs redirected to a temp dir.
- `app.py::_require_known_voice`: validate plain voice ids at the API boundary
  (mirrors the worker's lookup order: exported safetensors → raw file path →
  builtin name) → 404 `unknown voice`. Route-level tests switched from fake ids
  ("v", "test-voice") to builtin `alba`.

## Consequences
Positive: security-regression guard exists; the most common client mistake is
a 404, not a 500 + repeated model loads. Negative/risks: the known-voice check
adds two `is_file()` stats per request (negligible vs synthesis); a voice id
valid only inside pocket_tts but absent from BUILTIN would now 404 — BUILTIN is
the served catalog, so that id was never advertised.
Mitigations: raw-file-path convenience preserved.

## Rollout
1. `_require_known_voice` + test id migration — suite green. ✅
2. `test_auth.py` + `test_takes_reviews.py` + unknown-voice tests — 188 OK. ✅

## Acceptance criteria / Regression checklist
- [x] All 8 auth scenarios covered; env pin untouched (other modules still open-mode).
- [x] 188 tests OK (baseline 164; +2 F5, +2 F4, +20 this).
- [x] `test_errors.py` timeout test now uses `dataclasses.replace` (faithful SETTINGS stand-in).
