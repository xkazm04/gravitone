---
date: 2026-07-26
slug: codify-cross-process-sentinel
status: shipped
type: codification
vehicle: docs-claude
parent_strong_pattern: "[[Architect/strong-patterns#O_EXCL cross-process sentinel]]"
related_scan: "[[Architect/scans/2026-07-26-async-patterns]]"
---

# Codify: O_EXCL cross-process sentinel (S8)

## Why now
Identified this run and immediately load-bearing: finding 5 was caused by not
knowing it (a `threading.RLock` guarding a file N processes write). The same
run generalized it into `atomicio.file_lock`, so the convention has a canonical
implementation to point at while it is fresh.

## Vehicle and rationale
`docs-claude` (`.claude/CLAUDE.md`), added alongside the two conventions
codified earlier today. The rule is architectural — "which lock is the right
lock in this deployment topology" — so it must load into every session before
someone reaches for `threading.Lock` again. A test guard can't express it
(the anti-shape is legal Python that works fine in a single process); the
existing `test_file_lock.py` pins the primitive's behavior instead.

Two further conventions were codified in the same pass, both discovered by
this scan and both already regression-guarded:
- **Event-loop discipline** — guarded by `test_handler_modes.py`.
- **Web shared hooks + in-flight gates** — the F7 hooks.

## Rollback
Delete the sections from `.claude/CLAUDE.md`; `atomicio.file_lock` and its
tests remain, and `strong-patterns.md` keeps the entry as `noted`.
