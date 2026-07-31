---
slug: external-call-budget
type: perfect/direction
context: "[[Voice Cloning & Ingest Pipeline]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 05021e9
---
## What & why
A cloud clone costs 2 ElevenLabs calls plus 40 to 80 Gemini calls, and not one of them is retried. A transient ElevenLabs 500 fails the whole scan after the expensive part has already been paid for; a transient Gemini 429 silently degrades that segment to baseline, so the user gets a worse voice and is never told why. The pro-model escalation doubles the bill whenever confidence dips below 0.7, with no cap, no counter, and a swallowed exception that then reports the flash model as the source. Nothing caps input duration, so a three-hour upload goes straight to Scribe.

## Evidence
- `service/ingest.py:146` (`scribe`), `:155` (`voice_isolate`), `:173` (`_gemini`) — bare `urllib.request.urlopen`, no backoff, no 429/5xx handling, new TLS handshake per call.
- `service/ingest.py:379` — one `_gemini` request per segment, `limit=40` (`:358`), 4 concurrent (`LABEL_WORKERS`, `:61`).
- `service/ingest.py:184-190` — `label_emotion` re-calls `PRO_MODEL` whenever `confidence < 0.7`; `:189-190` swallows the escalation exception entirely and returns a result claiming `model: FLASH_MODEL`.
- `service/ingest.py:380-382` — `_label_seg`'s blanket `except` collapses "ffmpeg could not decode" and "Gemini 429" into the same silent baseline degradation; only a count reaches the UI.
- `service/ingest_api.py:357-359` — `probe_duration` enforces a floor only, no ceiling; `:112-117` returns `None` when ffprobe fails, silently disabling even the floor.
- Untested: every external-API function has zero mock-HTTP coverage.

## Acceptance criteria
- Retries with bounded backoff on transient failures (429/5xx/timeouts) for Scribe, Isolator and Gemini; a permanent failure is still permanent and still honest.
- Gemini labelling is batched rather than one request per segment (the API accepts multiple audio parts), cutting the call count materially — report the before/after count for a 40-segment job.
- Escalations are counted, capped by a documented budget, and surfaced; a failed escalation never reports the wrong model as its source.
- A duration ceiling is enforced BEFORE any paid call is made, and a missing/failed ffprobe fails closed rather than disabling the gate.
- The job reports what it actually spent (call counts per provider) so the cost is visible rather than inferred.
- Mock-HTTP tests for the retry, batch, escalation-cap and degradation paths — this is currently the largest untested surface in the service.

## Risks / non-goals
- Batching changes the labelling prompt shape; the builder must show that per-segment label quality does not regress (or say plainly that it could not verify it without live keys).
- Retries must not multiply spend on a genuinely failing provider — cap total attempts per job, not just per call.
- Non-goal: changing the emotion taxonomy, the 40-segment limit itself, or switching providers.

## Build record
Builder I-B. `_call()` now wraps every provider request: retries ONLY 408/425/429/5xx/timeouts, honours a capped `Retry-After`, deterministic bounded backoff, permanent 4xx raises immediately; `ExternalError` carries provider + status. `Spend` is both ledger and budget holder (attempts per provider, retries, escalations) and the retry budget is **per JOB** (`INGEST_JOB_RETRY_BUDGET=12`), shared by analyze and label through a per-job `_SPEND` entry — a test proves a dead provider costs 4 attempts across 3 calls with budget 1, not 9.

Batched labelling: `_gemini` takes a LIST, numbers the clips in the prompt and matches replies **by the echoed index**, so a reordered or short reply cannot shift labels onto the wrong audio; a clip the model skips comes back as `None` and degrades exactly that segment. Escalation is counted, capped (`INGEST_ESCALATION_BUDGET=12`) and honest — each segment carries `escalation: escalated|skipped|failed`, and a failed escalation keeps the flash label AND says the escalation failed, replacing the old swallowed exception that misreported the model. Duration ceiling (`INGEST_MAX_CLIP_SECONDS=900`) is enforced in /scan BEFORE any paid call and **fails closed** when duration is unknown (`probe_duration` now catches `OSError`, so a missing ffprobe rejects instead of waving the upload through). Failure honesty: `extract` vs `classify` are separate counters, an unlabelled segment is EXCLUDED from stems rather than silently poured into the neutral one, and a total classifier outage raises "could not be classified" instead of the lie "no speech detected in the clip".

**Director INDEPENDENTLY VERIFIED the headline claim** rather than taking the report's number: ran `_batches` directly on main — 40 segments → **5 requests** (was 40), and the small-job shrink is real (8 segments → 4 requests of 2, filling the pool, instead of 1 serial request of 8; 3 → 3×1; 0 → 0). Indices are fully covered with no overlap. With escalation the worst case moves from 40-80 uncapped to ≤10 plus a 12-segment escalation cap. Also re-ran `test_longform` 3× to check the wall-clock flake the builder reported under load — clean every time (17 passed), so it is not recorded as a standing flake.

**Unverifiable here, stated plainly**: the builder has no Gemini key, so it could NOT verify that classifying 8 clips in one request labels each as well as 8 separate requests. That is the direction's named risk and it was reported rather than papered over. A human must run a recording through cloud mode before/after and compare `result.segments[].emotion`. Also unverified: that real ElevenLabs 429/5xx responses carry the header/status shapes `_call` branches on, and that Gemini reliably emits the echoed `index` under `responseMimeType: application/json` (the parser degrades per clip rather than failing, but a systematically missing index would fall back to positional matching).

Gates on main: compileall clean, **389 passed, 28 subtests**. MERGED.
