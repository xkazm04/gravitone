# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

<!-- vibeman:context-map:start -->
## Context Map

This project has a Vibeman-generated context map at `context-map.json` (repo root). It maps every file to a feature ("context"), grouped by business domain. **Before editing code, read `context-map.json` to find the relevant context and scope your changes to its `filePaths`.** The `index` field is a quick one-line-per-context overview. If you change which files a context owns, update `context-map.json` to match (or run Vibeman's refresh) so it stays accurate.
<!-- vibeman:context-map:end -->

## Load-bearing conventions (codified by /architect, 2026-07-26)

### Engine job lifecycle discipline (service)

Every synthesis job's future is ALWAYS resolved — result, exception, cancel, or
`ShuttingDown` on drain — and the admission permit is released in a `finally`
(`gravitone/service/engine.py`, `_Worker.run`). Callers never hang; workers never leak
permits. Server-side failures reach clients only as sanitized request-id
messages (`gravitone/service/errors.py::sanitized_500`; canonical use `gravitone/service/app.py`
`_await_result`), with the raw cause logged against that id. When touching the
engine or adding endpoints: never let a code path leave a future pending, never
put raw exception text / subprocess stderr in a response body, and route new
error shapes through `gravitone/service/errors.py` (one `{"detail"}` contract; ingest-job
404s use `errors.job_expired()`). Anti-shape: a bare `except: return` around
worker awaits — see the streaming-swallow ADR for why that was a bug.

### Cross-process exclusion (service)

The service ships as **N single-worker processes** (`gravitone/service/replicas.py`,
`SO_REUSEPORT`), so a `threading.Lock` serializes nothing between replicas. For
any read-modify-write of a shared file, an in-process lock is not enough:
`os.replace` prevents a torn file, not a lost update. Use the `O_CREAT|O_EXCL`
sentinel — atomic create-if-absent across processes:

- **Waiting mutex**: `atomicio.file_lock(path)` (stale-lock reclamation
  included, since a SIGKILLed holder must not wedge the service). Canonical
  use: `voices.mutate_meta`, which takes it *alongside* the thread lock.
- **First-writer-wins**: `takes.py:230-245`'s `.pick` sentinel, when the
  contract is "one winner" rather than "everyone in turn".

Anti-shape: a bare `threading.Lock`/`RLock` guarding a file that another
process also writes. Also remember `JOBS`-style in-memory state is per-process
and is NOT shared between replicas — see "Ingest is replica-affine" in
`gravitone/deploy/README.md`.

### Event-loop discipline (service)

FastAPI runs `def` handlers and `def` dependencies in a threadpool, `async def`
on the single event loop. A handler that awaits an upload and then does real
work must be `def` (read the body with `file.file.read()`); `async def` is only
for handlers that are genuinely I/O-bound on awaits. Anything CPU- or
disk-heavy inside an `async def` goes through an executor — `app.py::_offload`
is the helper, and `gravitone/service/tests/test_handler_modes.py` fails if the known
offenders regress. Anti-shape: `subprocess.run`, multi-MB `write_bytes`,
`hashlib` over a whole upload, or a blocking lock acquired directly in an
`async def` route.

### The Signal design language (web)

`gravitone/web/DESIGN.md` is the house design language — read it before
touching any `gravitone/web` UI. Short form: the picture carries the story
(animated illustration from `components/variants/features/previews/illus.tsx`,
one accent, one caption, honesty drawn to scale from source data); functional
tools take the restrained tier (Signal accents in states/transitions, never a
performing illustration); entrance-only motion, still-aware via
`lib/useStillMotion`. Breaking a rule requires editing DESIGN.md in the same
commit.

### Honest failure surfaces (web)

Every user action and data read must represent its failure — no silent catch,
no false empty state, no stuck spinner. Convert non-OK responses via
`gravitone/web/lib/apiFetch.ts` (`throwDetail`/`apiJson`: defensive JSON parse, backend
`detail` first, 503 → "Gravitone backend unreachable"). Show inline failures
with `gravitone/web/components/ui/ErrorBanner.tsx` — severity `error` renders rose,
`warning` renders amber; do not hand-roll banner markup or reuse amber for
errors. Optimistic updates keep a snapshot and roll back with copy that states
the true state (canonical: `gravitone/web/app/keys/_variants/data.ts::revokeKey` — "the
key is still active"; its sibling `destroyKey` rolls back to "the key still
exists", because that is the state a failed DELETE leaves behind. Copy that
names the wrong state is the same bug as no copy at all). Pollers that retry forever must tell the user the
connection is degraded (`useIngestJob`'s `onStalled`).

Shared hooks, use them rather than re-rolling: `lib/useMounted` (guard every
`setState` after an `await`), `lib/useCopyFeedback` (copy label + cleaned-up
timer + a `failed` state — never claim "copied" when the clipboard refused),
`lib/useHealthPoll` (the one `/api/health` poller). Any mutation a user can
double-click needs an in-flight gate; a duplicate request that mints a
credential is a security bug, not a UX wart.
