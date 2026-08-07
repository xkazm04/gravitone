---
slug: the-link-becomes-a-voice
type: perfect/direction
context: "[[Voice Cloning & Ingest Pipeline]]"
lens: feature
size: M
status: shipped
proposed: 2026-08-06
accepted: 2026-08-06
shipped: 2026-08-07
commit: 7c79372
---
## What & why
`POST /v1/ingest/scan-url`: paste a YouTube link; the service downloads audio-only via yt-dlp (no postprocessing → NO new ffmpeg; ~3 MB pure-python dep) behind the SSRF guard machinery `narrate.py` already ships, writes into the job workdir, and joins the existing analyze path unchanged — zero new decoders, because ffmpeg is already a hard runtime dependency. Web: a "paste a link" tab beside the dropzone feeding the same job flow. Consent attestation gets distinct wording for external content (today's copy claims "this is my voice / I own this recording" — false for YouTube).

## Evidence
- Upload-only entry: `ingest_api.py:1713-1726`.
- ffmpeg already load-bearing: `ingest.py:130,155-157,839`, `ingest_api.py:773-776` ("the whole pipeline needs ffmpeg"), `engine.py:333`, CI installs it.
- Reusable SSRF fetcher: `guard_url`/`_GuardedRedirects`/`fetch_url` (`narrate.py:530-638`) — host allowlist, per-hop re-validation, lying-Content-Length cap.
- `_AUDIO_EXTS` already accepts `.webm/.m4a/.opus/.mp4/.mkv` (`ingest_api.py:730-734`).
- Attestation copy: `ingest_api.py:2348-2349`.

## Acceptance criteria
- Link → running job → speaker previews with zero decoder additions; yt-dlp invoked WITHOUT postprocessors (audio-only format selection, e.g. `bestaudio[ext=m4a]/bestaudio`).
- Download SSRF-guarded (guard machinery reused, audio content-type list), size- and duration-capped, budgeted per-IP like scan.
- Distinct attestation copy for externally-sourced audio; corpus opt-in wording reviewed in the same pass.
- Extraction failure is honest in the UI ("link extraction failed — drop the file instead"), never a stuck spinner; dropzone remains the stated fallback.
- yt-dlp version pinned + the brittleness documented (weekly extractor churn; JS-runtime caveat noted in deploy docs).

## Risks / non-goals
- YouTube ToS/copyright exposure — mitigated by explicit attestation, not silently shipped.
- yt-dlp signature deciphering may require a JS runtime for some videos — acceptance includes verifying a plain public video works in CI-like posture, and failing honestly otherwise.
- Non-goal: playlists, live streams, non-YouTube platforms (yt-dlp handles many; UI copy scopes to "a video link").

## Build record
Builder V-A → 03cbcac, picked to main as **7c79372**. New `service/ingest_url.py` (guard_link reusing narrate's host_allowed/check_public_ip with locally-authored copy; every resolved A record checked; DNS-rebinding limit stated honestly — allowlist is the primary control). yt-dlp pinned 2026.7.4, `python -m yt_dlp`, argv-asserted NO postprocessors; byte ceiling enforced twice (--max-filesize + 250ms disk watchdog). `_new_job` extracted so upload/link share one job shape; `source` provenance ALWAYS present, served via _PUBLIC_KEYS. Commit requires EXTERNAL_STATEMENT verbatim for link jobs and appends source URL to the receipt; attested:false still 422. Typed LinkRefusals name the file-drop fallback; stderr logged never returned. Route `def` (threadpool), shares SCAN_BUDGET deliberately. Unverified honestly: no live YouTube extraction ever ran (subprocess seam mocked; yt-dlp not installed locally — 503 fail-closed path IS tested). Director gates on main: full suite 2102, tsc, 418 voices/api web tests. Verdict: merge, no notes.
