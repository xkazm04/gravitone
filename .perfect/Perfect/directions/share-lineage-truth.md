---
slug: share-lineage-truth
type: perfect/direction
context: "[[tts-playground]]"
lens: robustness
status: shipped
size: S
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: aaa58aa
---
## What & why
Three honesty bugs on the share surface: the remix-parent sessionStorage key is never cleared, so every later unrelated publish is falsely filed as a child of the last take opened in the rack; the share page renders 404 for a backend that is merely down; a corrupt performance report decodes to "no segments" silently.

## Evidence
- OpenInRack.tsx:67 writes `gravitone.remix.parent`; engine.ts:99 reads it via duplicated literal on EVERY publish; zero clears (grep verified 2026-08-04).
- lib/takes.ts:66-68, 82-84 collapse unreachable and not-found into `null`.
- engineSeam.ts:228-231, 249-251 return `[]` on malformed base64.

## Acceptance criteria
- Remix parent is one-shot (cleared on first consuming publish) and read via the exported `REMIX_PARENT_KEY`.
- /t/[id] distinguishes "take gone" from "backend unreachable" (ErrorBanner conventions, honest copy).
- Corrupt segment/report payloads surface as a visible warning distinct from a single-segment take.
- Tests: remix one-shot; 404-vs-down; corrupt-report warning.

## Risks / non-goals
Non-goal: changing lineage semantics server-side.

## Build record
(pending)
Build record: P1 done. REMIX_PARENT_KEY centralized in composerStore, spent by first LANDED publish (failed publish keeps the fork); loadTake returns ok|gone|unreachable, share page + embed render honest outage state; corrupt reports get an amber warning (audio complete, breakdown is not). Merged aaa58aa.
