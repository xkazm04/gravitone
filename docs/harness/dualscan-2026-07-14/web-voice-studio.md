# Dual-lens scan — web-voice-studio
> Files: 11 | Findings: 5 (crit 0 / high 2 / med 2 / low 1)
> Lenses: bug-hunter + code-refactor

## 1. Voice Vault ownership record silently dropped when auth loads after commit completes
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: silent-failure / race-condition
- **File**: `web/app/voices/new/page.tsx:64`
- **Scenario**: A recording is scanned and committed. The commit leg finishes and `phase` flips to `"complete"` before Firebase's `onAuthStateChanged` has resolved `user` (fresh tab / slow auth). The effect runs, sets `recorded.current = true`, then hits `if (user && pending && created.length)` which is false because `user` is still `null`. When `user` populates a moment later the effect re-runs (it is in the deps), but the very first line `if (phase !== "complete" || recorded.current) return;` now short-circuits — the record never fires.
- **Root cause**: The idempotency latch (`recorded.current = true`) is set *before* the guarded work, so a run that did no work still consumes the one-shot. It assumes `user` is always ready by commit-complete.
- **Impact**: The Voice Vault ownership/consent mapping (`users/{uid}/voices/{voice_id}`) is never written for that character. The user's own attestation of the cloned voices is silently lost, with no error surfaced.
- **Fix sketch**: Move the latch inside the success branch — only set `recorded.current = true` after `recordVoiceOwnership(...)` is actually dispatched (i.e. inside `if (user && pending && created.length) { recorded.current = true; void recordVoiceOwnership(...) }`), leaving it `false` so a later `user` render can complete it.

## 2. commit() has no in-flight guard — a double click fires two commits
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: double-submission / race-condition
- **File**: `web/app/voices/new/page.tsx:111`
- **Scenario**: On the review screen the "Create character" button is only `disabled={selected.size === 0 || !consented}` — never disabled while a request is in flight. A physical double-click queues two `click` handlers before React re-renders; both read the same closure snapshot (`phase === "review"`), both dispatch `COMMIT_STARTED`, and both `POST /api/ingest/{job}/commit`. `startScan` (line 82) has the same shape and can spawn two ingest jobs, keeping only the second `job_id` and orphaning the first server-side.
- **Root cause**: Re-entrancy is not gated in either the handlers or the reducer; the phase transition that hides the button happens asynchronously after the handler yields at `await fetch`, so it does not protect the second synchronous click.
- **Impact**: Duplicate voice-clone commit for one job — wasted CPU cloning, potential duplicate voices/ownership rows, and duplicated consent submission; scan double-submits orphan a workdir/job.
- **Fix sketch**: Add a `submitting` ref (or a `busy` phase flag in the reducer) checked at the top of `commit`/`startScan`/`chooseSpeaker`, cleared in `finally`; or disable the button on `phase !== "review"` as well as the busy flag.

## 3. chooseSpeaker swallows backend errors and transitions optimistically
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: silent-failure
- **File**: `web/app/voices/new/page.tsx:97`
- **Scenario**: `chooseSpeaker` fires `POST /api/ingest/{job}/speaker` with no `await r.ok` check and no `catch`, then immediately dispatches `SPEAKER_CHOSEN` moving the UI to `processing`. If the job expired (proxy returns 404/`backend unreachable` 503) or the speaker id is rejected, the failure is invisible: the UI shows the Waveform Lab spinning while the server is still `awaiting_speaker` (or gone). It only self-corrects on the next poll (flashing back to the speaker list) or lands on `expired`.
- **Root cause**: Fire-and-forget mutation with an unconditional optimistic dispatch — no reconciliation of the HTTP result before advancing the state machine.
- **Impact**: Confusing flicker back to the speaker picker under normal transient errors; a genuine backend rejection is never surfaced as an error message. Degraded, misleading UX at a decision point.
- **Fix sketch**: `const r = await fetch(...); if (!r.ok) { dispatch SET_ERROR from body; return; }` before dispatching `SPEAKER_CHOSEN`; wrap in try/catch mirroring `startScan`.

## 4. Duplicated streaming-proxy route logic (speaker-preview / stem preview)
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `web/app/api/ingest/[job]/preview/[emotion]/route.ts:4`
- **Scenario**: This file and `web/app/api/ingest/[job]/speaker-preview/[sid]/route.ts` are byte-for-byte identical except the upstream path segment (`/preview/{emotion}` vs `/speaker-preview/{sid}`): same `backendFetch`, same `if (!r.ok)` handling, same `Response(r.body, …audio/wav, "private, max-age=3600, immutable")`, same 503 catch.
- **Root cause**: Two GET handlers copy-pasted for two near-identical audio-asset proxies rather than sharing a helper.
- **Impact**: Any change to the audio proxy (cache policy, content-type, error shape, auth header) must be made in two places and can drift; a cache-header bug fixed in one silently persists in the other.
- **Fix sketch**: Extract `streamIngestAsset(upstreamPath: string): Promise<Response>` into `web/lib/backend.ts` (or a local `_shared.ts`) and have both routes call it with their upstream path.

## 5. Dead re-export of emotionMeta in shared loader module
- **Severity**: low
- **Lens**: code-refactor
- **Category**: dead-code
- **File**: `web/app/voices/new/_loaders/shared.tsx:60`
- **Scenario**: `shared.tsx` imports `emotionMeta` from `@/lib/emotions` (line 4) solely to re-export it (`export { emotionMeta };`, line 60). Nothing in `_loaders/` or `page.tsx` imports `emotionMeta` from `./shared` — `page.tsx` imports it directly from `@/lib/emotions`, and `WaveformLab` only pulls `EmotionTally`, `stateOf`, `LoaderData`.
- **Root cause**: A pass-through re-export left behind after callers were pointed at the canonical `@/lib/emotions` source.
- **Impact**: Misleading second import path for the same symbol; trivial dead code.
- **Fix sketch**: Delete line 60 and drop `emotionMeta` from the line-4 import (keep `EMOTIONS`).
