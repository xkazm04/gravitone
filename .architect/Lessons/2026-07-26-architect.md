# Lessons — /architect run 2026-07-26 (error-handling, scan mode)

Sub-agents spawned: 4 angles (usage map, proxy contract, UI surfaces, test coverage)
Findings surfaced: weak 3, strong 2, swap 0, struct-bug 2, convention-gap 1
Triage: executed ALL (user override "execute all now"; skill recommends 1/session — 6 executed cleanly in ~one sitting because 5 of 6 were small-to-medium and the gates are fast)

## Self-reflection
- Strong signal: the proxy-contract and UI-surface angles converged on the same
  seam from opposite sides — pairing a boundary's two sides as separate angles
  is a reusable scan design.
- The test-coverage angle prevented a trap: it proved the suite was GOOD
  (failure-oriented), so the right fix was targeted gap-filling (auth env pin),
  not a "testing strategy overhaul" a shallower scan would have proposed.
- Execution ordering that worked: service (small→large) then web
  (infra→consumers), so each later decision landed on the previous one's
  primitives (errors.py before voices.py fix; proxyJson before apiFetch;
  apiFetch/ErrorBanner before the six hole fixes).
- Friction: Write tool requires Read-before-write on files dumped via cat —
  batch-Read route files upfront next time.
- Environment fact for future runs: `python -m unittest discover -s
  service/tests -t .` from gravitone/ is the real test gate (188 tests,
  pytest not needed); tests pin TTS_API_KEY="" at package import.
- Cross-session pattern (matches /perfect config taste): everything here was
  correctness/honesty/consolidation — the exact category that user accepts.
  Predict high acceptance for similar future slates.
