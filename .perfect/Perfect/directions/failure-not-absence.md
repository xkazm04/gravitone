---
slug: failure-not-absence
type: perfect/direction
context: "[[Character & Voice Management]]"
lens: robustness
status: shipped
size: S
proposed: 2026-07-29
accepted: 2026-07-29
shipped: 2026-07-29
commit: b4c39be
---
## What & why
A corrupt registry now 503s service-wide — and the roster renders "No characters match." underneath the error banner. The detail page is worse: everything that is not a 404 falls through to the "No character 'x'" dead-end, so a temporarily unreadable registry is presented as *this character does not exist*. A third roster fetch in the create flow bypasses the shared data layer entirely and renders its own failure as "you have no characters to extend".

## Evidence
- `web/app/voices/_data/characters.ts:241-253` — on failure `characters` stays `[]`, `error` is set, `loading` goes false in the `finally`. (Director-verified.)
- `web/app/voices/_variants/CharacterTable.tsx:283-284` — `{!loading && rows.length === 0 && … "No characters match."}`. (Director-verified.)
- `service/voices.py:161-190` — `RegistryCorrupt` 503 with a user-showable detail; `apiFetch.ts:30` only substitutes "backend unreachable" when detail is absent, so the message survives — only the empty table lies.
- `characters.ts:160-165` — `fetchCharacter` maps 404→null and throws otherwise; `CharacterVoices.tsx:51-60` renders the "No character" block with the error text substituted.
- `web/app/voices/new/page.tsx:104-109` — a third `apiJson("/api/characters")` bypassing `loadRoster`, contradicting `characters.ts:86`'s claim that the duplicates were consolidated; its `.catch` sets `[]`, disabling "Extend existing" (`:597`).
- The fix pattern is already in-repo: `web/app/profile/MyVoices.tsx:33-39`.

## Acceptance criteria
- No surface renders an empty state when the underlying read FAILED — a failure is a failure everywhere on this route.
- A 503 on the detail page reads as unavailable-and-retryable, not as nonexistent.
- The create flow's roster load either joins `loadRoster` or its divergence is justified in a comment that is actually true; either way its failure is not rendered as an empty roster.
- Tests cover the failure-vs-empty distinction, since that is the whole point.

## Risks / non-goals
- Non-goal: changing the 503 contract, which round 7 chose deliberately.
- Be careful not to convert a genuine empty roster (a new install) into an error — the two states must both be expressible.

## Build record
Builder V1. A failed roster read left `characters` at `[]` with `loading`
false, so `CharacterTable` printed "No characters match." directly under its own
error banner — a 503 rendered as "you have nothing". Added `readFailed` /
`notFound` as flags distinct from `error` (deliberately not reusing `error`,
which mutations also set) and a retry. Squarely the repo's own no-false-empty
-state law.
