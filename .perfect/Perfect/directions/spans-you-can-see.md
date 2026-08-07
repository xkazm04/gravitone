---
slug: spans-you-can-see
type: perfect/direction
context: "[[TTS Playground]]"
lens: ux
size: M
status: shipped
proposed: 2026-08-06
accepted: 2026-08-06
shipped: 2026-08-07
commit: 3719488
---
## What & why
The text surface renders emotion spans as visible colored highlights (overlay under the textarea text), bracket markup hidden or dimmed — the paragraph reads as a performance, not markup. Selection stays visible while the emotion wheel is open. Combining emotions across a paragraph becomes glanceable; the "closing returns to baseline, not the enclosing emotion" semantics become visible instead of a playback surprise.

## Evidence
- Raw textarea, no rich surface anywhere: `PlaygroundConsole.tsx:1386-1390`, script lines `:1416-1425`.
- Non-nesting close-to-baseline semantics: `service/emotions.py:87-93`, documented `shared.ts:404-409`.
- Selection invisible during pick: wheel portals + moves focus (`EmotionPicker.tsx:59`), `insertEmotion` reads a blurred textarea's selection.

## Acceptance criteria
- Spans visibly highlighted (per-emotion color) in solo and script modes; markup not shown raw by default, with a power-user toggle.
- Selection visibly persists while the picker is open.
- Overlay tracks scroll/resize/wrap exactly (mirror-div discipline); no divergence at 8000-char texts.
- Zero change to payloads or persistence.

## Risks / non-goals
- Mirror-div overlays are finicky (font metrics, IME) — acceptance includes a stress test, and falling back to plain textarea must remain possible.
- Depends on [[one-emotion-model]]'s region-first state — builder forks AFTER it merges.

## Build record
Builder P-B → 2ee9808, picked as **3719488**. New `ScoreText.tsx`: mirror-div under transparent-background textarea; alignment VERIFIED (scrollHeight compare per layout + ResizeObserver + fonts.ready; on disagreement the paint withdraws but characters stay — an emptied mirror could never re-measure, so degradation would latch). Not color-only: tint + 2px under-rule + 1px side rules, all inset box-shadows (zero layout cost). `runs()` pure single partition on region∪selection edges; stress test at 8000 chars/40 regions. Markup toggle = read-only `<pre>` + useCopyFeedback. Builder deleted the now-redundant reading line. Known limit: height-compare misses same-height wrap divergence (judged acceptable, recorded). Director gates on main: tsc + full web 1349. Verdict: merge.
