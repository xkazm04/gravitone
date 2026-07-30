# REPORT — AUDIBLE (Audible Docs / Narration Dock), Batch 4

> Saved by the orchestrator from the builder's inline report. Builder was interrupted by the
> weekly API limit mid-flight and resumed from transcript after reset — completed cleanly.

**Status: complete.** tsc clean; full vitest 50 files / 641 tests green (PlaygroundConsole
flake passed too).

Files (web/): new `lib/narratable.ts`, `lib/narrationCache.ts`,
`components/ui/NarrationDock.tsx` + 3 colocated tests (64: hash stability/field-collision,
both routes, dock reducer, narrator pick, cache round-trip + storage-unavailable);
`app/layout.tsx` mount only.

UX decisions: registry derived from content.ts/benchmarks.ts only (never scraped DOM);
ear-normalized ("1.9×" → "1.9 times"); sentence-granular with one-ahead prefetch; collapsed
pill → glass transport; collapse keeps playing; focus follows the toggle; Space/arrows/Escape
with Space yielding to focused buttons; ?narrate=1 arms, never plays; /api/speak is the
public relay (no sign-in) — 401/403 reported as a DEPLOYMENT key fault; busy/unreachable/
blocked/no-Characters all named; highlight survives reduced motion, scrolling does not.

Caught a real bug: invisible control bytes had landed in a hash template — identical-looking
strings hashed differently. Now `hashParts` with an explicit String.fromCharCode(31).

Hooks: none. Deferred (per design): build-time narration baking, POST /v1/narrate, the
embeddable narrate.js.
