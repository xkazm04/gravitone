# Architect Preferences (distilled from /architect runs)

> Rules upgraded from `Lessons/` after repeated observation. Loaded by Phase 1.

## Triage calibration

- **This user executes full slates.** Two runs (2026-07-26 error-handling and
  async-patterns), both times "execute all". Don't push the skill's default
  one-decision-per-session recommendation; instead present the slate already
  **sequenced by dependency order** (service before web, shared primitive
  before its consumers) so wholesale execution is safe. State the sequence in
  the triage message.
- Inherited from `/perfect` taste and confirmed twice: correctness, honesty,
  efficiency and consolidation land; new UX surfaces don't. Every finding
  executed across both runs was one of those four.

## Scan design

- **Pair angles across a seam.** Two agents examining the same boundary from
  opposite sides (service errors ↔ proxy contract; thread boundary ↔ event
  loop) converge on the same modules independently, which is the cheapest
  severity signal available.
- **Hunt partial clones of the best module.** Both runs' highest-payoff
  findings came from: identify the most rigorous implementation in the theme,
  then audit every caller that copies its shape incompletely.
- **One angle should read deploy/config files**, not just application code.
  Config that silently contradicts the code is invisible otherwise.

## Draining a backlog (resume mode)

- **Order by what unblocks, not by payoff.** Run the item that creates a gate
  (a test runner, a shared primitive) before the items that would otherwise
  ship without one.
- Items may merge when they touch the same code — keep separate ADRs so the
  decision record stays accurate even when the commits don't line up 1:1.
- Ship the destructive item last, and test the thing it must NOT destroy.

## Execution

- Write a mechanically-checkable guard test for any convention being codified
  (`test_handler_modes.py`, `test_file_lock.py`). ~40 lines, converts an
  aspiration into a contract.
- When asserting on `inspect.getsource`, strip docstrings first — they often
  mention the very anti-shape the test forbids.
- Keep an explicit UNVERIFIED list in every ADR. This machine has no TTS
  runtime, no Docker/helm, and no dev-server session; a green `tsc` or unit
  suite is never the same as a verified behavior.
- **When a code path gains a new side effect, grep for every existing test that
  reaches it** — twice now a test has written the repo's real `voices/_meta.json`
  because a shared path started calling `mutate_meta`. Run `git status` after
  the suite; a clean tree is part of "green".
- Distinguish pre-existing problems from ones you introduced (e.g. `npm audit`
  findings that predate your install) and say which is which.
