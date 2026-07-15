# Dual-lens scan — svc-synthesis-api
> Files: 5 | Findings: 5 (crit 0 / high 3 / med 2 / low 0)
> Lenses: bug-hunter + code-refactor

## 1. Every managed-key request blocks the async event loop on a synchronous file read
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: event-loop-blocking / lock-contention
- **File**: `service/keys.py:165`
- **Scenario**: A client authenticates with a managed (`/v1/keys`) key while the service is under concurrent load. Every such request routes through the async dependency `dep` (`service/auth.py:50`) → `_authorize` → `validate_key`, which does `with _STORE_LOCK: data = _load()` — a blocking `KEYS_PATH.read_text()` + `json.loads()` (`service/keys.py:62-68`) executed inline on the asyncio event loop, under a process-global lock also held by create/rotate/delete.
- **Root cause**: Auth was written as a synchronous helper but is invoked directly from an `async def` dependency with no `run_in_executor`, and it re-reads + re-parses the entire key file from disk on *every* call rather than caching an in-memory view. The whole point of the service (WORKERS-parallel synthesis) is defeated at the auth layer.
- **Impact**: Under concurrency, managed-key traffic serializes through one lock + a synchronous disk read per request, and the blocking `read_text` stalls the entire event loop (all other in-flight requests, including streaming) for the duration of each read. Root-key traffic (the web studio) escapes this via the early return at `service/auth.py:35`, so the regression only shows up for third-party API consumers — exactly the certification/load-test path.
- **Fix sketch**: Cache the parsed key store in memory (invalidate on create/rotate/delete), compare hashes against the cache with no per-request disk read, and if a read is unavoidable move it off the loop via `await run_in_executor`. The debounced `last_used` persist can already be async/fire-and-forget.

## 2. Non-atomic key-store write + swallowed JSON error silently destroys all managed keys
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: silent-failure / data-loss
- **File**: `service/keys.py:71`
- **Scenario**: The process is killed (deploy, OOM, crash) while `_save` is midway through `KEYS_PATH.write_text(...)`, leaving `api_keys.json` truncated. On the next request `_load` (`service/keys.py:62-68`) hits `json.JSONDecodeError` and returns `{}`. Every managed key now 401s, `list_keys` reports zero keys, and the next `create_key` writes `{new_key}` over the truncated file — permanently erasing the surviving entries.
- **Root cause**: `_save` writes in place (no temp-file + atomic `os.replace`), and `_load` treats a corrupt store as an *empty* store instead of surfacing the failure. Corruption is indistinguishable from "no keys ever existed" (success theater).
- **Impact**: A single ill-timed crash silently invalidates every issued API key. Because secrets are shown only once, recovery means re-issuing and redistributing every key. No log, no alarm — the first signal is customers reporting 401s.
- **Fix sketch**: Write to `KEYS_PATH.with_suffix(".tmp")` then `os.replace()` for atomic durability; in `_load`, on `JSONDecodeError` log an error and either fail closed or read a `.bak` copy rather than returning `{}` — never let corruption masquerade as an empty store.

## 3. Streaming synthesis errors are swallowed with no log, no metric, and a 200 to the client
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: silent-failure
- **File**: `service/app.py:478`
- **Scenario**: On `/v1/text-to-speech/{voice_id}/stream`, a mid-stream segment raises inside the worker (or times out). The handler `except (asyncio.TimeoutError, Exception): return` (`service/app.py:478-481`) just ends the generator. The client already received `200 OK` + headers, so it sees a short/truncated clip and a cleanly closed connection with no error indication.
- **Root cause**: Once the streaming headers are flushed there is no HTTP status left to signal failure — but unlike the non-stream path (`_await_result` at `service/app.py:179-188`, which logs the worker exception against a request id and increments `on_timeout`), the stream path logs nothing and records no metric. The failure is invisible on both ends.
- **Impact**: A user's generation silently truncates and operations has zero signal — no error log, no timeout counter — so recurring worker failures under load are undetectable from telemetry. Debugging a "my audio cut off" report is blind.
- **Fix sketch**: In the `except`, log the exception with a request id (mirroring `_await_result`) and call `ENGINE.metrics.on_timeout()` on `TimeoutError` before returning. Consider distinguishing `ShuttingDown`/`TimeoutError` from a genuine synthesis error in the log so the two are separable.

## 4. Root and managed key comparison is not constant-time
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: security / timing-side-channel
- **File**: `service/auth.py:35`
- **Scenario**: An attacker who can send many authenticated requests and measure response latency probes `if secret == SETTINGS.api_key` (`service/auth.py:35`) — an ordinary short-circuiting string compare that returns faster the earlier it mismatches. The managed-key hash check at `service/keys.py:167` (`k.get("hash") == h`) has the same property.
- **Root cause**: Secret comparison uses `==` rather than a constant-time primitive; the timing leak on the root `TTS_API_KEY` is the higher-value target since it grants unlimited/admin scope.
- **Impact**: Byte-by-byte timing recovery of the root key is theoretically possible. Exploitability is low over a network with synthesis jitter, but the root key is the crown-jewel credential and the fix is trivial.
- **Fix sketch**: Compare with `secrets.compare_digest(secret, SETTINGS.api_key)` for the root key, and compare the SHA-256 hashes in `validate_key` with `secrets.compare_digest` as well.

## 5. `/v1/performance` re-implements X-Ignored-Settings, duplicating the canonical order list
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `service/app.py:634`
- **Scenario**: `/v1/performance` builds its ignored-settings header manually — `sorted({...}, key=["similarity_boost", "style"].index)` at `service/app.py:634-635` and `{"X-Ignored-Settings": ",".join(ignored)}` at `service/app.py:692` — instead of reusing `_ignored_settings`/`_ignored_headers` (`service/app.py:123-141`), which every other endpoint uses.
- **Root cause**: The per-line aggregation across `req.lines` was written inline, hardcoding the `["similarity_boost", "style"]` ordering that already lives (implicitly, by append order) in `_ignored_settings`. Two sources of truth for the same field set and ordering.
- **Impact**: If pocket-tts later exposes a knob and a third inert field is added to `_ignored_settings`, `/v1/performance` silently won't surface it, and its `.index` call would raise `ValueError` on the new name — a latent divergence bug seeded by the duplication.
- **Fix sketch**: Add a small helper (e.g. `_ignored_settings_many(list_of_vs)`) that unions `_ignored_settings(vs)` across lines preserving the canonical order defined in one place, and have `/v1/performance` call it + `_ignored_headers`-style formatting, deleting the hardcoded order list.
