---
slug: slug-truth-in-ui
type: perfect/direction
context: "[[Character & Voice Management]]"
lens: robustness
status: shipped
size: S
proposed: 2026-07-29
accepted: 2026-07-29
shipped: 2026-07-29
commit: 9ea5270
---
## What & why
The studio previews the slug a user is about to mint using the substitution half of `normalize_emotion` with the validation regex omitted — so it promises "[battle_cry!] is addressable immediately" and then the request 400s. The character half is wrong in a different way: it substitutes only whitespace where the server substitutes every non-alphanumeric run, so "Mary O'Brien" is displayed as `mary-o'brien:sarcastic` — a copy-pasteable API address that 404s. There is no web-side equivalent of `normalize_emotion` anywhere.

## Evidence
- `web/app/voices/[characterId]/_variants/EmotionRack.tsx:199-200` — `custom.trim().toLowerCase().replace(/[\s-]+/g, "_")` and `name.toLowerCase().replace(/\s+/g, "-")`. (Director-verified.)
- `service/emotions.py:49-62` — `_EMOTION_RE = ^[a-z][a-z0-9_]{1,23}$`; the substitution is only half the function, and an invalid slug raises. (Director-verified.)
- `service/voices.py:326-328` — `_slug` substitutes `[^a-zA-Z0-9]+`; `web/app/voices/new/page.tsx:743` duplicates it CORRECTLY, so the repo already contains a right answer the rack does not use.
- `EmotionRack.tsx:186` — `maxLength={24}` is the only client-side constraint; it covers neither the 2-char minimum, the leading-letter rule, nor the character class.
- The 400 does reach the user (`characters.ts:215-223` → `throwDetail` → `EmotionRack.tsx:55`) — so this is not silence, it is a contradiction: the panel says valid two lines below the input that says invalid.

## Acceptance criteria
- One web-side emotion validator mirroring `normalize_emotion`, and one slug helper mirroring `_slug`, used everywhere a slug is previewed OR submitted.
- An invalid name is refused at the input with the reason, before any round trip.
- Every "addressable immediately" example the UI prints actually resolves against the API.
- The two sides cannot silently diverge again — a drift guard or a single derivation, in the spirit of round 7's header-contract guard.

## Risks / non-goals
- Client validation is an optimization for the user, never the enforcement point — the backend must keep rejecting.
- Non-goal: changing the emotion grammar or the 24-char cap.

## Build record
Builder V1. `EmotionRack.tsx:199` previewed `name.toLowerCase()` with only
whitespace substituted, so "Mary O'Brien" rendered a copy-pasteable address the
API 404s on, and `maxLength={24}` was the entire client-side validation against
a regex the service enforces. Extracted `web/lib/slugs.ts` as the ONE web
mirror (3 copies of the rule -> 1) plus `slugs.test.ts`, a drift guard that
parses `service/emotions.py` and `service/voices.py::_slug` and fails on
divergence. Director teeth-checked the guard: changing the Python regex to
{1,31} failed it; restoring passed.
