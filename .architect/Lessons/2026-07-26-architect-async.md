# Lessons — /architect run 2 (async-patterns, scan mode), 2026-07-26

Invoked as `/architect resume`; backlog was empty (run 1 executed everything),
so the mode question went back to the user, who chose a fresh scan.

Sub-agents: 4 angles (thread↔asyncio boundary, lifecycle/cancellation, web
effect hygiene, event-loop blocking)
Findings: weak 3, strong 1, swap 0, struct-bug 3, convention-gap 1
Triage: executed ALL 8 (user override, second run in a row)
Result: 7 commits, service suite 194 → 209, tsc clean throughout

## Self-reflection

- **The strongest scan design so far: pick angles that meet at a seam from
  opposite sides.** Run 1 paired service-errors with proxy-contract; this run
  paired thread-boundary with event-loop-blocking. Both times the two reports
  independently converged on the same modules, which made severity calibration
  almost free — a finding two blind agents both surface is real.
- **A recurring codebase shape, now named twice**: a rigorous core (engine.py,
  and in run 1 the service error contract) whose discipline is *not applied by
  its callers*. Worth leading with this hypothesis on the next scan: find the
  best-engineered module in the theme, then audit everyone who clones its
  pattern partially. That single question produced findings 2, 3 and 5.
- **"async def only to await file.read()" is a generalizable smell.** All five
  loop-blocking offenders had the same origin story. When a scan finds one
  handler-mode mistake, enumerate every handler of the same shape immediately.
- **The lifecycle angle earned its slot by reading deploy files.** The two
  highest-leverage config findings (unmounted workdir, stop-grace shorter than
  the drain) were invisible from application code alone. Give at least one
  angle explicit permission to read Dockerfile/helm/systemd.
- **Guard tests are the cheap half of a codification.** `test_handler_modes`
  and `test_file_lock` cost ~40 lines each and make three CLAUDE.md conventions
  enforceable rather than aspirational. Default to writing one whenever the
  anti-shape is mechanically detectable.
- **Miss to avoid repeating**: I wrote a source-inspection guard test that
  matched the word `run_in_executor` inside the docstring explaining why the
  function avoids `run_in_executor`. Strip docstrings before asserting on
  source, or assert on behavior.
- **Calibration**: predicted "1=execute now, queue the rest"; the user executed
  all 8 for the second time today. Two data points — for this user, on this
  repo, a well-evidenced correctness/robustness slate gets executed wholesale.
  Stop hedging the recommendation toward one-per-session; instead sequence the
  slate by dependency order up front (service→web, infra→consumers), which is
  what actually made 8-in-one-session safe here.
- **Honesty ledger held**: every ADR carries an explicit UNVERIFIED list (no
  TTS runtime, no Docker/helm, no dev server). Nothing was marked shipped on
  the strength of a green `tsc` alone without saying so.
