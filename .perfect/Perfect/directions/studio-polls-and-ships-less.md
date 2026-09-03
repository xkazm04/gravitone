---
slug: studio-polls-and-ships-less
type: perfect/direction
context: "[[voice-creation-studio]]"
lens: optimization
status: shipped
size: M
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: 3bc7677
---
## What & why
useIngestJob polls the FULL job (result: stems + casting + every labeled segment with text) every 1.5-5s even during commit when the UI reads three integers — no ETag, no visibility handling. The right shape here: slow-while-hidden + immediate-on-return (the poll drives a terminal transition — never fully stop). The 998-line page statically imports the entire review machinery (SegmentBoard, AuditionPanel, motion) for a route whose first paint is a dropzone.

## Evidence
- useIngestJob.ts:26-30 backoff, no document.hidden; ingest_api.py:1096-1115 _PUBLIC_KEYS includes result; page.tsx:829-831 reads 3 ints during commit
- zero next/dynamic in web/app; page.tsx static imports

## Acceptance criteria
- Visibility-aware polling (slowed hidden, immediate on visible, never stopped) — tested with mocked visibility.
- Polling stops re-shipping unchanged result payloads (ETag/If-None-Match or slim view during committing) — service/proxy additions pre-authorized narrowly.
- SegmentBoard + AuditionPanel dynamically imported; first-paint bundle drops them.
- Existing useIngestJob tests stay green; new ones for both behaviors.

## Risks / non-goals
Terminal-transition latency must not regress (immediate poll on visible). Same builder as [[review-doesnt-die-silently]], sequenced.

## Build record
(pending)
Build record: S-B done. Hidden→30s cadence with pending-wait re-arm, visible→immediate; proxy-side sha256 ETag + If-None-Match 304 (client keeps job, counts as healthy poll); SegmentBoard+AuditionPanel via next/dynamic (repo's first) — 7.3kB chunk out of first paint, /voices/new 18.4kB/362kB first load. Seam noted: a service-side rev would let the proxy skip the upstream fetch. Merged 3bc7677.
