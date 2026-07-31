# Lessons — /architect run 3 (resume, backlog drain), 2026-07-26

Third run of the day. Resume mode with a real queue this time: all 4 pending
items drained. 4 commits (440eecd, cd86742, b49d37f, 4413dda). Service suite
209 → 219; web went from **no test runner at all** to 30 tests.

## Self-reflection

- **Ordering the drain by unblocking value beat ordering by priority.** The
  test runner was the lowest-payoff item on paper (payoff 2–3) but doing it
  FIRST meant the two web items shipped with real behavioural tests instead of
  `tsc` alone. Rule: when draining a backlog, run the item that creates a gate
  before the items that need one.
- **Two items merged naturally.** The `AbortSignal` parameter belonged to the
  same edit as the fallback-reason work (both restructure the same catch
  blocks), so the signal plumbing + tests shipped with B3 and only the UI
  control shipped as B2. Draining a backlog is not obliged to preserve its
  item boundaries — but each still got its own ADR, so the record stays honest
  about what was decided when.
- **The riskiest item went last, deliberately** — `remove_voices` is the only
  destructive code shipped in three runs. It got 7 tests of its own, two of
  which exist purely to prove it does NOT over-delete (the cancelled-extend
  case). When shipping a delete, test the thing it must not delete.
- **Repeat of a mistake I already logged, in a new disguise.** Run 2's lesson
  was "a test wrote the real registry". It happened AGAIN here: adding rollback
  made a *pre-existing* test start calling `mutate_meta` for real. The first
  fix was too narrow — I isolated the one test I wrote instead of noticing that
  any test touching `_do_commit`'s cancel arm now hits the registry. Better
  rule: when a code path gains a new side effect, grep for every existing test
  that reaches it. Catching it was luck of running `git status`; a
  `conftest`-style global registry redirect would make it structural.
- **Silly self-inflicted bug worth remembering**: I inserted a new helper
  directly beneath `@router.delete(..., status_code=204)`, so the decorator
  bound to my function and FastAPI asserted at import. When adding a function
  near routes, check what's immediately above the insertion point.
- **Pre-existing vs introduced.** `npm audit` fired 3 high advisories during
  the vitest install; they were all in `next`/`postcss`/`sharp` and predated
  the change. Queued rather than fixed — a Next bump is its own decision — and
  said so explicitly instead of letting the number look like fallout from my
  install.
