# Dual-lens scan — svc-concurrency-replicas
> Files: 3 | Findings: 5 (crit 0 / high 2 / med 3 / low 0)
> Lenses: bug-hunter + code-refactor

## 1. Parent holds a dead replica's SO_REUSEPORT socket open, black-holing ~1/N of traffic during crash-backoff
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: race-condition / resource-lifetime
- **File**: `service/replicas.py:223`
- **Scenario**: A replica crashes and enters restart backoff (0.5s escalating to 30s). `_make_reuse_socket` (208-215) was called in the *parent*, which `listen(128)`s and keeps `r.sock` open for the child's whole lifetime ("kept alive so its fd stays open", line 171). The child accept()s via the inherited fd; the parent never accept()s. When the child dies, only the child's fd copy closes — the parent's listening socket stays in the SO_REUSEPORT group. `check_once` (251-272) never closes it on death; it is only replaced at the next `_spawn_one` (or in `shutdown`).
- **Root cause**: The design pre-binds the reuseport socket in the supervisor and relies on the child to serve it, but treats socket ownership as permanent instead of tied to a live child. An open-but-unserved reuseport member is a member the kernel still load-balances onto.
- **Impact**: While a replica is down (up to the 30s backoff, repeatedly under a crash loop), the kernel routes a ~1/N share of new connections into the orphaned socket's accept queue where nothing drains them; those clients hang until the backlog fills (then SYNs drop), and get an RST when the socket is finally reassigned at restart. A quarter of users (4-replica deploy) see stalls/resets for the whole backoff window — silently, since the pool still reports "up".
- **Fix sketch**: The child keeps its own inherited fd across exec, so the parent doesn't need to hold the socket. Close `r.sock` right after a successful `_spawn_one`, or at minimum close it the moment `check_once` detects the death (before the backoff wait) and recreate it in `_spawn_one`. That removes the dead socket from the reuseport group so no connection is routed to an unserved endpoint.

## 2. Non-atomic cross-process write to emotion_demand.json can corrupt it, and `_load` silently resets ALL counts to {}
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: silent-failure / state-corruption
- **File**: `service/demand.py:50`
- **Scenario**: The launcher runs N replica processes (replicas.py). The `_LOCK` in `record_fallback` is per-process only, so two replicas can `DEMAND_PATH.write_text(json.dumps(data), ...)` concurrently. `write_text` truncates then writes the full JSON blob non-atomically; interleaved writes of a multi-KB file can leave a torn/partial JSON on disk. The next `_load` (28-35) hits `json.JSONDecodeError`, catches it, and returns `{}`.
- **Root cause**: The module's stated tradeoff is "multi-replica fleets will undercount (last-writer-wins), which is acceptable." That framing only covers a *lost increment*; it does not cover a *torn file*, which the swallow-and-return-`{}` path silently converts into total history loss.
- **Impact**: A single interleaved write wipes the entire demand signal — the whole point of the feature (the "angry requested 214× — record it now" recording queue) resets to empty with no error logged. In a real multi-replica deploy (exactly the topology replicas.py builds) this is not a rare theoretical case.
- **Fix sketch**: Write to a sibling temp file and `os.replace()` onto `DEMAND_PATH` (atomic rename) so a reader never sees a partial file; and/or log at warning level when `_load` discards a JSONDecodeError instead of silently zeroing. A durable multi-writer store would be the real fix, but atomic-replace stops the corruption-reset.

## 3. `submit` check-then-put on `_stopping` is not atomic with `stop()`'s drain — a late job leaks its admission permit and hangs its caller
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: race-condition (TOCTOU)
- **File**: `service/engine.py:492`
- **Scenario**: Thread A enters `submit`, passes `if self._stopping` (line 492, False), then is preempted before line 506. `stop()` runs on another thread: sets `_stopping=True`, `_drain_queue()` (empty), puts N sentinels, joins workers up to `drain_timeout_s` (10s), `_drain_queue()` again. Thread A resumes, `self._admit.acquire()` succeeds, `on_enqueue` (queued++), and `self._queue.put(job)` lands the job *after* the final drain. Workers have already exited on their sentinels, so nothing dequeues it.
- **Root cause**: Admission (`_stopping` read) and enqueue (`_queue.put`) are separate steps with no mutual exclusion against the shutdown sequence; the two `_drain_queue` sweeps in `stop()` bound the window but cannot cover a put that happens after the second sweep.
- **Impact**: The job's `Future` is never resolved, so the caller blocks until its own request timeout instead of getting a clean 503; the admission permit is never released (one slot permanently lost) and `queued` is stuck at +1 for the life of the process. Shutdown-only, but it defeats the module's "every pending future is resolved before stop returns" guarantee.
- **Fix sketch**: Make admission atomic with the stopping flag — e.g. re-check `_stopping` under a lock while enqueuing, and if set, release the permit + raise `ShuttingDown` instead of putting; or have `submit` enqueue then have `stop` drain in a loop until the queue stays empty across a short quiescent check with new admissions already refused.

## 4. `wav_bytes_to_mp3` runs ffmpeg with no timeout — a wedged encoder hangs the calling thread indefinitely
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: recovery-gap / unbounded-external-call
- **File**: `service/engine.py:91`
- **Scenario**: `subprocess.run(cmd, input=wav_bytes, ...)` is invoked with no `timeout=`. If the ffmpeg child wedges (stuck decode of a pathological input, a paused/stopped process, a stalled binary), `subprocess.run` blocks forever. There is no request-timeout escape here — the calling worker/request thread parks with no recovery.
- **Root cause**: The engine carefully bounds every internal path (admission, queue, request_timeout_s) but delegates MP3 transcode to an external process with no wall-clock ceiling, trusting ffmpeg to always terminate.
- **Impact**: One wedged ffmpeg pins a thread permanently; if this runs on the request path it consumes a concurrency slot and the caller never gets a response or a 5xx, degrading the pool with no signal in metrics.
- **Fix sketch**: Pass `timeout=<seconds>` to `subprocess.run` and convert `subprocess.TimeoutExpired` into a `RuntimeError` (the process is killed on timeout), mirroring the deterministic-degradation philosophy of the engine's admission control.

## 5. `AGG_KEYS` duplicates the engine's metrics counter names across modules with no shared source of truth
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication / hidden-coupling
- **File**: `service/replicas.py:50`
- **Scenario**: `AGG_KEYS = ("received","completed","rejected_429","errored","timeouts","abandoned","in_flight","queued")` (replicas.py 50-53) hand-mirrors the exact counter keys emitted by `Metrics.snapshot()` in engine.py (the `base` dict, lines 242-251). The aggregator sums only these literal strings.
- **Root cause**: The two modules share an implicit contract on counter names but keep two independent copies of the list; the comment "mirrors the engine Metrics snapshot" is the only link.
- **Impact**: If engine renames a counter (e.g. `rejected_429`) or adds one, `aggregate_metrics` silently drops it from pool totals with no error — the aggregated `/metrics` endpoint under-reports and no test/type-check catches the drift. Real maintainability debt on a monitored surface.
- **Fix sketch**: Export the counter-key tuple once from the engine metrics module (e.g. `Metrics.COUNTER_KEYS`) and have replicas.py import it for `AGG_KEYS`, so adding/renaming a counter is a single-site change that automatically flows into aggregation.
