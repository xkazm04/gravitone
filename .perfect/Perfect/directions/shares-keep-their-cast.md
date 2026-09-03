---
slug: shares-keep-their-cast
type: perfect/direction
context: "[[tts-playground]]"
lens: feature
status: shipped
size: M
proposed: 2026-08-04
accepted: 2026-08-04
shipped: 2026-08-04
commit: 58fd9c3
---
## What & why
Ensemble takes lose their cast on publish: only the first line's character_id is uploaded, `SharedTake.segments` has no per-character field, TakeScore cannot lane a multi-voice take, and `/v1/takes/{id}/reperform` silently re-performs the whole ensemble in ONE voice. The flagship multi-character composer demo degrades into a false artifact the moment it is shared.

## Evidence
- PlaygroundConsole.tsx:977,981 first-line characterId + "Ensemble · N voices" label
- engine.ts:101 uploads single character_id; lib/takes.ts:18 no per-segment character
- TakeScore.tsx:105-131 one flat rail; RePerform.tsx:106 misleading sentence
- service/takes.py:434 single-voice reperform, no notice

## Acceptance criteria
- Per-segment character identity flows publish → takes.py storage → share payload.
- TakeScore lanes multi-character takes (one lane per character).
- Re-perform uses per-line voices, or the UI + response state plainly that it cannot.
- Narrow additive changes to service/takes.py pre-authorized; migration-safe for existing stored takes.
- Tests: upload round-trip with cast; lane rendering; reperform honesty.

## Risks / non-goals
- Existing shared takes lack cast data — must degrade gracefully.
- Non-goal: editing cast on the share page.

## Build record
(pending)
Build record: P1 done. Per-segment character_id/name publish→takes.py→share→TakeScore lanes; reperform gained cast 'lines' form, per-line voices concatenated, cast-mismatch 403 (consent scoped to parent cast), char cap over the SUM; castless takes get single_voice+notice. Builder design call: per-turn cast form UI. Merged 58fd9c3.
