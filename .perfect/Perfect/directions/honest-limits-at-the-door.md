---
slug: honest-limits-at-the-door
type: perfect/direction
context: "[[Voice Cloning & Ingest Pipeline]]"
lens: robustness
size: S
status: shipped
proposed: 2026-08-06
accepted: 2026-08-06
shipped: 2026-08-07
commit: 9b0bd62
---
## What & why
The URL path inverts the upload flow's protections: caps (50 MB / 900 s) were sized for a user's own clip, and the browser-side duration pre-check doesn't run for a pasted link — a 2-hour podcast would fail only AFTER the wait. Probe video metadata BEFORE downloading and give the verdict at paste time: "47-minute video — we'll clone the first 15" (or reject, with the cap stated). Enforce a download-side ceiling independent of headers; budget the URL route per-IP.

## Evidence
- Caps: `MAX_UPLOAD_BYTES = 50 MB` (`ingest_api.py:725`), `MAX_CLIP_SECONDS` = 900 s (`config.py:137`).
- Browser duration pre-check bypassed by a URL path (`web/app/voices/new/page.tsx:1289-1304`).
- Existing per-IP budgets to mirror: `SCAN_BUDGET` 12/10 min burst 3, `AUDITION_BUDGET` 40/10 min (`ingest_api.py:716-719`).
- Lying-header discipline prior art: `fetch_url` reads one byte past cap (`narrate.py:623`).

## Acceptance criteria
- Paste-time verdict (metadata probe, no media download) before any transfer: duration, and the trim-or-reject decision stated in copy.
- Product decision implemented: over-cap videos are trimmed to the first `MAX_CLIP_SECONDS` with explicit copy (Director's call: trim beats reject for demo value — a builder may challenge with evidence).
- Download enforces a byte ceiling regardless of declared size; over-cap never reaches analyze.
- URL route budgeted per-IP; 429 carries Retry-After (verified, not assumed — round-6 lesson).

## Risks / non-goals
- Metadata probe itself is a yt-dlp call — must respect the same SSRF/budget guards; probe failure → honest "can't read this link" with the file-drop fallback.
- Non-goal: user-selectable trim window (future); spend/cost readouts (standing taste veto).
- Same files as [[the-link-becomes-a-voice]] — SAME builder brief (V-A), split commits.

## Build record
Builder V-A → 234ffa5, picked to main as **9b0bd62**. `/v1/ingest/link/probe` (own looser LINK_BUDGET 30/10min — transfers no media; but budgeted because outbound connections), paste-time verdict debounced in `useLinkProbe`; button reads "Scan the first 15 minutes →". Trim via `--download-sections` + `_enforce_trim` re-probes the delivered file and cuts locally with existing ffmpeg (stream-copy first, WAV re-encode fallback) — trim is a fact about the FILE; TRIM_TARGET 5s under ceiling for container slop; verdict re-taken server-side for probe-skipping clients. Retry-After VERIFIED already present on 429s (round-6 gap closed earlier); new test drives a real 429. Builder also found+fixed a LinkRefusal escaping as sanitized 500 outside the try block. Director gates: same integration run as 7c79372. Verdict: merge, no notes.
