---
slug: truthful-pipeline-feedback
type: perfect/direction
context: "[[Voice Creation Studio]]"
lens: ux
status: shipped
size: S
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: 6bce07a
---
## What & why
Backend reports label_errors but the UI's Partial type omits it — users see a thinner emotion rack with no explanation. Sovereign mode never detects emotions yet the loader says "Detecting emotions". No client-side upload pre-validation (60MB uploads fully then bounces); picker accept list narrower than backend's. A11y gaps: dropzone not keyboard-operable, unlabeled preview buttons, bare progress bar.
## Evidence
ingest.py:401 vs shared.tsx:6-17; WaveformLab.tsx:34-36; page.tsx:208 vs ingest_api.py:66-70; page.tsx:201-207, :328-331, :394-395.
## Acceptance criteria
- label failures surfaced ("N segments couldn't be classified")
- sovereign loader copy honest (server step labels)
- client-side size/type/duration pre-check before upload; drag-drop validated identically
- picker accepts what the backend accepts
- dropzone keyboard-operable; progressbar + preview buttons aria-labeled
## Risks / non-goals
No recorder; no preflight audio analysis (rejected separately).
## Build record
Round 2 wave 1, 2026-07-13. Opus builder; Director-reviewed; gates green (113 unittests + tsc). 6bce07a.
