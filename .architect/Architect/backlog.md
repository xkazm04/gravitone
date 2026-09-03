# Architect Backlog

Durable queue of architectural decisions. Sorted by priority.
Status values: `proposed | approved | in-progress | shipped | abandoned | blocked`.

## Pending

- **[2026-07-26] Roll back a commit that ERRORS mid-way** — struct-bug, risk 3, effort m, payoff 2, reach: 1 path (`_do_commit` except arm)
  Source: [[Architect/decisions/2026-07-26-cancelled-commit-rollback]] (the sibling case, deliberately left)
  Status: proposed
  Notes: the *cancel* path now rolls back. An erroring commit still leaves the emotions that succeeded, because `ingest.commit` raises without returning the created list. Arguably correct (an error is not the user asking to undo) — decide the semantics first, then either attach `created` to the exception or leave it and document the behaviour in the UI.

- **[2026-07-26] Widen web test coverage beyond the conventions** — convention-gap, risk 1, effort m, payoff 2, reach: web app
  Source: [[Architect/decisions/2026-07-26-web-test-runner]]
  Status: proposed
  Notes: the runner exists with 30 tests covering apiFetch / ErrorBanner / useCopyFeedback / engine fallback+abort. Untested still: `useIngestJob` polling and stall detection, `useMounted`, the optimistic-rollback data hooks, `useAudioPlayer`. Cheap now that the harness is in place.

- **[2026-07-26] Pre-existing npm advisories** — security, risk 2, effort m, payoff 2, reach: `next`, `postcss`, `sharp`
  Status: proposed
  Notes: `npm audit` reports 3 high advisories, all in Next.js and its transitive deps (SSRF/DoS/cache-confusion in Next, XSS + path traversal in postcss, libvips CVEs in sharp). NOT introduced by the test-runner install — they predate it. `npm audit fix` claims to resolve all three; a Next bump is a real decision with its own regression surface, so it is queued rather than done as a side effect.

## Shipped

### Run 3 — backlog drain (2026-07-26)
- **Web test runner (vitest)** — convention-gap, ADR [[decisions/2026-07-26-web-test-runner]], commit 440eecd
- **Honest fallback reason** — weak-pattern, ADR [[decisions/2026-07-26-honest-fallback-reason]], commit cd86742
- **Cancellable synthesis** — convention-gap, ADR [[decisions/2026-07-26-cancellable-synthesis]], commit b49d37f
- **Cancelled-commit rollback** — struct-bug, ADR [[decisions/2026-07-26-cancelled-commit-rollback]], commit 4413dda

### Run 2 — async-patterns (2026-07-26)
- **Abandon protocol on batch routes** — struct-bug, ADR [[decisions/2026-07-26-abandon-protocol]], commit 4c20acf
- **Blocking work off the event loop** — weak-pattern, ADR [[decisions/2026-07-26-loop-blocking]], commit fb0743e
- **One teardown protocol for ingest jobs** — struct-bug, ADR [[decisions/2026-07-26-ingest-teardown]], commit 13db576
- **Cross-process registry lock** — struct-bug, ADR [[decisions/2026-07-26-cross-process-registry]], commit 3b183f2
- **Deploy config honors durability** — weak-pattern, ADR [[decisions/2026-07-26-deploy-durability]], commit 4aa0be3
- **Critical web async holes** — struct-bug, ADR [[decisions/2026-07-26-web-critical-async]], commit b92ae3f
- **Shared web async hooks** — convention-gap, ADR [[decisions/2026-07-26-web-async-hygiene]], commit 2b318a5
- **Codify O_EXCL sentinel + event-loop + web-hooks conventions** — codification, ADR [[decisions/2026-07-26-codify-cross-process-sentinel]]

### Run 1 — error-handling (2026-07-26)
- **Streaming mid-flight swallow** — struct-bug, ADR [[decisions/2026-07-26-stream-swallow]], commit ceeb6eb
- **Service error taxonomy (errors.py + catch-all)** — weak-pattern, ADR [[decisions/2026-07-26-error-taxonomy]], commit 633bdbc
- **Auth 401 matrix + packs/takes tests + voice 404** — weak-pattern, ADR [[decisions/2026-07-26-auth-coverage]], commit 85a0b59
- **Proxy error contract (proxyJson, 26 routes)** — weak-pattern, ADR [[decisions/2026-07-26-proxy-contract]], commit 21dab69
- **Client fetch helper + ErrorBanner convention** — convention-gap, ADR [[decisions/2026-07-26-client-fetch-surface]], commit e9ab0ce
- **Six silent-failure holes** — struct-bug, ADR [[decisions/2026-07-26-silent-failures]], commit 5345246
- **Codify S7+S8 into CLAUDE.md** — codification, ADR [[decisions/2026-07-26-codify-strong-patterns]]

## Abandoned / Blocked
_None yet._
