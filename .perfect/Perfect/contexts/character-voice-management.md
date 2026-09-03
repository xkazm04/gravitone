---
name: Character & Voice Management
type: perfect/context
group: Web Studio
category: ui
opportunity: 7.5
last_proposed: 2026-07-29 (round 8)
cooldown_until: round 10
directions: ["[[show-consent-provenance]]", "[[one-data-layer]]", "[[right-sized-fetches]]", "[[firstclass-custom-emotions]]", "[[demand-driven-queue]]", "[[slug-truth-in-ui]]", "[[failure-not-absence]]", "[[duplicate-visible-deletable]]", "[[collision-gets-an-answer]]", "[[destroy-deliberately]]"]
---
## Round-8 re-scout (2026-07-29) — the UI vs the registry rewritten under it
Re-scouted on both triggers: the brief dated from round 3 AND `service/voices.py` was substantially rewritten in round 7. **All five round-3 directions verified live**; `one-data-layer` is INCOMPLETE — `voices/new/page.tsx:104-109` still keeps a THIRD roster fetch, contradicting `characters.ts:86`.

Round-7 gap table (Director-verified where load-bearing):
- **The UI promises a slug is valid, then the server rejects it** (`EmotionRack.tsx:199-200` omits the validation regex; its character slug differs from `_slug`). → [[slug-truth-in-ui]]
- **A corrupt registry reads as "you have no characters"** (`CharacterTable.tsx:283-284` + `characters.ts:241-253`); the detail page renders a 503 as "No character 'x'". → [[failure-not-absence]]
- **A tolerated duplicate is invisible, therefore undeletable** (`characters.ts:334` `.find()`), defeating the doctrine at `voices.py:470-492`. → [[duplicate-visible-deletable]]
- **Collisions get a generic banner**; quick clone names from the FILENAME so `mary.wav` always 409s and the file is discarded; rename/tag offered on premade rows with no guard. → [[collision-gets-an-answer]]
- **Destructive actions are the only ungated ones**; rollback re-fetches instead of restoring a snapshot; failure copy does not state what survived. → [[destroy-deliberately]]
- Safe but worth knowing: `PATCH /v1/voices/{id}` has ZERO web callers, so round 7's `extra="forbid"` 422 is unreachable — but `api/voices/[id]/route.ts:1` still documents "retag / rename", and `GET /api/voices` is dead too.
- Not taken: no re-slot UI at all; `useVoicePreview`'s bare `catch {}`; rename is `onDoubleClick`-only (keyboard-unreachable); no `aria-sort`; identical `aria-label` on every preview button; `window.confirm`/`prompt` for the consent gate; several dead modules; `CAPTURE_ORDER` a fourth ordering of the same eight ids.

## Round-8 re-scout (2026-07-29) — the UI vs the registry rewritten under it
Re-scouted on both triggers: the brief dated from round 3 AND `service/voices.py` was substantially rewritten in round 7. **All five round-3 directions verified live**; one is INCOMPLETE — `one-data-layer` consolidated the playground onto `loadRoster` but `voices/new/page.tsx:104-109` still keeps a THIRD roster fetch, contradicting the comment in `characters.ts:86` that says the duplicates were consolidated.

Round-7 gap table (Director-verified where load-bearing):
- **The UI promises a slug is valid, then the server rejects it.** `EmotionRack.tsx:199-200` implements the substitution half of `normalize_emotion` and omits the validation regex, so "Battle Cry!" previews as addressable and 400s. Its character slug also differs from `_slug` (`\s+` vs `[^a-zA-Z0-9]+`), so "Mary O'Brien" is shown as `mary-o'brien:sarcastic` — a copy-pasteable API address that 404s. `voices/new/page.tsx:743` duplicates `_slug` CORRECTLY, so the repo already holds a right answer this file does not use. → [[slug-truth-in-ui]]
- **A corrupt registry reads as "you have no characters."** On any roster failure `characters` stays `[]` and `loading` goes false, so `CharacterTable.tsx:283-284` renders "No characters match." under the error banner — the exact lie round 7's 503 exists to prevent. The detail page renders a 503 as "No character 'x'". → [[failure-not-absence]]
- **A tolerated duplicate is invisible, therefore undeletable.** `characters.ts:334` takes `.find()` — one row per scale emotion, first match wins — so the shadowed voice has no row and no remove button, defeating the explicit doctrine at `voices.py:470-492`. It does NOT mis-attribute the speaking voice (the backend pre-sorts and `_by_emotion` takes the first), it just hides the other one. → [[duplicate-visible-deletable]]
- **Collisions get a generic banner.** Quick clone names the character from the FILENAME, so `mary.wav` is a guaranteed 409 and the file is discarded; the only 409 handler is pack-import's prompt, whose copy is now false for a built-in collision and which throws away the detail naming it; rename/tag are offered on premade rows with no category guard, optimistically painted, then snapped back. → [[collision-gets-an-answer]]
- **Destructive actions are the only ungated ones** (voice, character, bulk) while consent and import-rename both confirm; rollback re-fetches instead of restoring a snapshot; failure copy does not state what survived, where the backend's partial-delete 500 specifically means the voice is intact. → [[destroy-deliberately]]
- Safe but worth knowing: `PATCH /v1/voices/{id}` has **zero web callers**, so round 7's `extra="forbid"` 422 is not reachable from the studio — but `api/voices/[id]/route.ts:1` still documents "retag / rename", two capabilities the backend now refuses, and `GET /api/voices` is dead too.
- Not taken: no re-slot UI at all (the write path round 7 hardened is unreachable); `useVoicePreview`'s bare `catch {}`; rename is `onDoubleClick`-only, so keyboard-unreachable; no `aria-sort` on sortable headers; identical `aria-label` on every row's preview button; `window.confirm`/`prompt` used for the consent gate (a compliance surface that cannot be styled, translated or tested); `nextEmotionToRecord`, `TagEditor`'s non-compact branch and `_variants/data.ts` re-exports all dead; `CAPTURE_ORDER` is a fourth ordering of the same eight ids.


## Current state (scouted 2026-07-13 — BANKED, no slate yet; pool filled first)
Works: roster table (search/sort/tag-filter/bulk select+tag+delete), coverage pips, inline rename/tags, quick clone with consent confirm, pack import/export (backend fully built: sha256 + HMAC), emotion rack with demand heat badges + custom slots, GuidedRecorder, ApiPanel curls, deep-link ?record=.
Rough (slate fodder for round 3): consent flag never displayed anywhere (data.ts:6-15 omits it); manifest endpoint never called (detail page loads ENTIRE roster to show one character, useCharacterVoices.ts:26-38); demand heat absent from roster; dead disabled "replace" button (EmotionRack.tsx:132-134); preview failures swallowed (data.ts:144-146); optimistic PATCH never re-syncs on success (drift from server normalization); GuidedRecorder hardcodes 8/8 — custom emotions invisible to it (GuidedRecorder.tsx:135,190); CoverageBar renders base-8 pips vs backend n/total mismatch (CharacterTable.tsx:22); bulk ops = N serial round-trips (CharacterTable.tsx:86-94); full roster refetch after every mutation; two parallel hooks duplicate fetch/CRUD (useCharacters vs useCharacterVoices); window.confirm/prompt consent gates; packs UI minimal (no provenance/license/signature display though backend stores imported{from,at}).
## Direction history
2026-07-29 (round 8) — proposed 5, **all 5 accepted**: slug-truth-in-ui ✅ failure-not-absence ✅ duplicate-visible-deletable ✅ collision-gets-an-answer ✅ destroy-deliberately ✅. Re-scouted because `service/voices.py` had been substantially rewritten the day before (normalize-on-write 400s, built-in collision 409s, `PATCH` losing `name` under `extra="forbid"`) and the round-3 brief predated all of it.
2026-07-13 (round 3) — proposed 5 from banked scout, ALL accepted: show-consent-provenance, one-data-layer, right-sized-fetches, firstclass-custom-emotions, demand-driven-queue.
## Shipped
Round 8 (2026-07-29) — all 5:
- [[slug-truth-in-ui]] → **9ea5270** — the slug preview showed an address the API 404s on, and `maxLength={24}` was the whole client-side validation. `web/lib/slugs.ts` is now the one web mirror (3 copies → 1) with `slugs.test.ts` as a drift guard that parses the Python.
- [[failure-not-absence]] → **b4c39be** — a 503 rendered as "No characters match." under its own error banner. `readFailed`/`notFound` are now distinct from `error`, plus a retry.
- [[duplicate-visible-deletable]] → **f7e1ee5** — a duplicated emotion slot hid the shadowed voice entirely (no row, no id, no remove). `Slot` carries `voices: Voice[]`; `buildSlots` extracted pure and tested.
- [[collision-gets-an-answer]] → **048a20f** (+ Director repair **f04a3c2**) — a quick clone names the character after the FILENAME and the built-ins are ordinary first names, so `mary.wav` was a guaranteed 409 that discarded the file. Now retained, renameable without re-attesting consent, and a slot collision links the voice it names.
- [[destroy-deliberately]] → **9613db6** — the three destructive paths were the only single-click actions on the surface; they now ask, naming what is lost (the bulk question names the count), roll back from a snapshot, and say what SURVIVED a failure, split by what the backend actually guarantees.
