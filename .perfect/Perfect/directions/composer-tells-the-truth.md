---
slug: composer-tells-the-truth
type: perfect/direction
context: "[[TTS Playground]]"
lens: robustness
size: S
status: shipped
proposed: 2026-08-06
accepted: 2026-08-06
shipped: 2026-08-07
commit: caeb5f7
---
## What & why
Live lint before generate: unclosed tags ("this span runs to the end of the text"), malformed tags ("this will be spoken out loud" — the true, loud failure mode), unknown emotion names ("`excitedd` isn't recorded — nearest match will be used"), and the `[baseline]` contradiction. Plus the FIRST Python unit tests for `parse_segments`, and the digit-asymmetry fix: `normalize_emotion` accepts digits (`mode2` is a legal emotion) but `_TAG_RE` rejects them, so no inline tag can address it.

## Evidence
- `_TAG_RE = r"\[(/?)([a-zA-Z_]*)\]"` (`service/emotions.py:66`) vs `normalize_emotion` `[a-z][a-z0-9_]{1,23}` (`:51-64`); web mirror `shared.ts:307-316`.
- Malformed tags unmatched → spoken literally (`emotions.py:76-94`); unknown well-shaped names silently resolve via fallback chain (`:414-455`).
- `parse_segments` has zero tests (grep: 4 hits, none in `service/tests/`).
- `composerLimit` checks only length/bytes/lines (`shared.ts:513-543`).

## Acceptance criteria
- Each failure mode gets a named inline pre-submit warning (ErrorBanner conventions; no invented banner markup); warnings name the OUTCOME, not just the syntax.
- `parse_segments` unit-tested: malformed, pseudo-nested, unknown, empty-span, case, whitespace.
- Digit fix lands server-side (`_TAG_RE`) + web `TAGGABLE`, with the grammar-parity test in `score.test.ts` extended to digits.
- Lint reads the derived regions/string — one implementation, both modes.

## Risks / non-goals
- Digit fix widens the grammar — verify narrate/reperform/API-key surfaces tolerate digit tags (same parser, shared).
- Non-goal: changing fallback semantics; `fell_back` reporting stays as-is.

## Build record
Builder P-A → de73019, picked to main as **caeb5f7**. `composerWarnings` one implementation both modes, four named outcomes, amber ErrorBanners, advisory (Generate still fires). `_TAG_RE` → `\[(/?)([a-zA-Z_][a-zA-Z0-9_]*|)\]` (strict superset), mirrored in tagRe/TAGGABLE, parity tests extended both directions; `mode2` now taggable so those two score.test.ts cases re-aimed at `2fast`/`battle-cry` (genuinely refused by both grammars). First `parse_segments` tests: 20 + 5 subtests. Judgment call kept: unknown-warning vocabulary = the cast's SCALE, not recorded slots (recorded-slot gaps are the chips' job). Builder full suite 2038 passed; Director on main: parse_segments + emotion suites + tsc green. Verdict: merge, no notes.
