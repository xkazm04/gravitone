---
slug: deployment-posture-truth
type: perfect/direction
context: "[[API Key Management]]"
lens: feature
status: shipped
size: S
proposed: 2026-07-29
accepted: 2026-07-29
shipped: 2026-07-29
commit: f2752a2
---
## What & why
The studio lets a user mint scoped keys, shows them in a tidy ledger — and never mentions that with `TTS_API_KEY` unset the service accepts every unauthenticated request, so those keys enforce nothing. That is the most misleading thing this surface can do: it looks like access control. The inverse is equally unsaid: round 6 made setting a root key close `/docs`, `/redoc` and `/openapi.json` and gate the `/metrics` detail — a real consequence an operator should know before flipping it.

## Evidence
- `service/auth.py:34-35` — empty `TTS_API_KEY` means open; every managed key is then decorative.
- `web/app/keys/_variants/KeysLedger.tsx:38-42` — the page prose frames keys purely as a migration convenience; no mention of `TTS_API_KEY` anywhere in the keys UI or `web/lib/switchkit.ts`.
- Round 6: `32cd96b` gates `/metrics` and the docs surface when a key is set; `0e4d82f` adds CORS default-closed. Neither is mentioned where a user would act on it.
- `service/auth.py:20` — docstring still says "scoped to a subset of {tts, voices, clone}", missing `performance` (`keys.py:69`), stale since round 4.

## Acceptance criteria
- The keys surface states whether key enforcement is actually ON for this backend, rather than leaving it to be inferred from the existence of keys.
- What setting a root key changes (docs surface, `/metrics` detail) is stated where the operator would act on it.
- Nothing invents a claim the studio cannot verify — if the studio cannot determine the backend's posture, it says that rather than guessing.
- The stale `auth.py` scope docstring is corrected in passing.

## Risks / non-goals
- The studio may genuinely be unable to see the backend's posture (an unauthenticated studio against a keyed backend is a legitimate deployment — round 7 established that). Report uncertainty honestly rather than probing in a way that could mislead.
- Non-goal: changing the open-by-default posture itself, which is a separate product decision already flagged in the vault.

## Build record
Builder K2. A ledger full of tidy scoped keys looks like access control
whether or not the deployment checks any of them — with `TTS_API_KEY` unset the
service serves every unauthenticated request and these keys enforce nothing.
The honest part is what K2 refused to claim: only a 401 proves enforcement is
on, and a served list proves NOTHING (the studio's proxy attaches its own key,
so keyed and open backends are identical from the browser). So the states are
`enforced` / `unknown` / `unreachable`, and `unknown` is a warning rather than
a guess. Distinguishing open-mode needs an unauthenticated server-side probe —
left as a follow-up rather than invented.
