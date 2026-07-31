---
date: 2026-07-26
slug: codify-strong-patterns
status: shipped
type: codification
vehicle: docs-claude
parent_strong_pattern: "[[Architect/strong-patterns#Engine job lifecycle discipline]], [[Architect/strong-patterns#Honest failure surfaces]]"
related_scan: "[[Architect/scans/2026-07-26-error-handling]]"
---

# Codify: engine job lifecycle discipline (S7) + honest failure surfaces (S8)

## Why now
Both identified this run with strong convergence across scan angles; the same
run shipped the modules (`service/errors.py`, `web/lib/apiFetch.ts`,
`ErrorBanner`) that give each pattern a canonical anchor — codifying while the
anchors are fresh.

## Vehicle and rationale
`docs-claude` (`.claude/CLAUDE.md`): both are conventions every future session
must know before editing; this repo has no ESLint-custom-rule infrastructure,
and S7's mechanical half is already guarded by tests (test_streaming abandon
tests, test_replicas AggKeys contract). A vitest-style structural guard for S8
is not possible (web has no test runner) — noted as a gap.

## Rollback
Delete the "Load-bearing conventions" section from `.claude/CLAUDE.md`; the
underlying entries remain in `Architect/strong-patterns.md` as `noted`.
