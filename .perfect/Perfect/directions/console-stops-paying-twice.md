---
slug: console-stops-paying-twice
type: perfect/direction
context: "[[tts-playground]]"
lens: optimization
status: shipped
size: S
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: 5d75a79
---
## What & why
Playback progress re-renders the entire 1,668-line console ~4×/s (the exact bug RenderStatus was extracted to fix for the render clock); the health poll runs forever in hidden tabs; the PUBLIC share page decodes the full WAV on the main thread and drags the playground engine (wavEncode, engineSeam, apiFetch) into its bundle to draw 64 bars, and likely fetches the take 3× per view.

## Evidence
- useAudioPlayer.ts:31-33 setProgress per timeupdate → PlaygroundConsole.tsx:292, consumed in takes map :1503, AnimatePresence layout children :1474; RenderStatus precedent :101-108
- useHealthPoll.ts:39-69 no visibilitychange
- TakeCard.tsx:52,68 second decode; computePeaks imported from _variants/engine
- t/[id]/page.tsx:17,36 loadTake in generateMetadata AND body, cache:no-store + fresh AbortSignal defeats memoization

## Acceptance criteria
- Progress display isolated (RenderStatus pattern) — console body no longer re-renders on timeupdate.
- Health poll pauses when document hidden, resumes on visible.
- Share page computes peaks without importing the playground engine module graph.
- One backend fetch per share-page view (hoisted/shared loader).
- Tests where behavior is assertable (poll pause, loader single-call).

## Risks / non-goals
Coordinate with [[one-transport-with-a-seek-seam]] (same files) — sequenced same builder.

## Build record
(pending)
Build record: P2 done. Progress = subscribable ref via useSyncExternalStore (console body render count flat across timeupdate ticks, probe-tested); useHealthPoll pauses hidden / immediate poll on visible; lib/peaks.ts breaks the share-page → engine import edge; lib/takes.server.ts wraps loaders in React cache() (one loadTake+loadLineage per request; not unit-assertable outside RSC — verify live). Merged 5d75a79.
