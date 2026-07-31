---
name: API Key Management
type: perfect/context
group: Web Studio
category: ui
opportunity: 8
last_proposed: 2026-07-29 (round 8)
cooldown_until: round 10
directions: ["[[revoke-not-destroy]]", "[[secret-not-losable]]", "[[deployment-posture-truth]]", "[[compat-check-real-path]]", "[[keys-surface-tested]]"]
---
## Current state (FIRST DEEP SCOUT, 2026-07-29, round 8)
Score raised 6.5 → 8: the backend was overhauled in round 4 and the studio never caught up, so this is a whole context of shipped-but-undelivered capability plus real defects.

Mounts (all traced, all render): `/keys` → `page.tsx:5-13` → `AppFrame` → `KeysLedger` (no switcher, ledger won its prototype round). `SecretReveal` is mounted unconditionally at `KeysLedger.tsx:35`, driven by the `reveal` state set on create AND rotate. `MigrationKit` renders only inside the reveal modal (`SecretReveal.tsx:61`). Second entry point from `profile/page.tsx:149-151`.
The whole keys router sits behind `require_scope("admin")` (`app.py:1209`) and `auth.py:52` refuses managed keys for admin outright — so the proxy MUST attach the root key, which `backend.ts:11-16` does.

**THE HEADLINE — the kill button lies.** `POST /v1/keys/{kid}/revoke` (round 4, `keys.py:274-296`) is unreachable: the proxy has POST→rotate and DELETE only. The ledger's button is LABELLED "revoke" and calls `deleteKey` → DELETE, whose own failure copy says "revoke failed — the key is still active" (Director-verified at `KeysLedger.tsx:115` / `data.ts:82-101`). So the one action available for a leaked credential destroys its audit identity — which `keys.py:15-19` documents as the wrong tool for a leak — with no confirmation. `revoked` is typed at `data.ts:15` and never read, so a revoked key renders byte-identical to a live one. `.claude/CLAUDE.md:66-68` cites this very function as the canonical rollback example.

Caught up: scope selection on create (the one item fully surfaced), rotate's in-flight double-mint gate (`KeysLedger.tsx:98-106`), `last_used` via `relTime`.
Not caught up: revoke (above), the `revoked` state, `GET /v1/keys/scopes` (never called — `SCOPES` is a hardcoded duplicate of `keys.py:69`, currently in sync so latent drift only).

Rough (Director-verified where load-bearing):
- **The once-only secret is losable**: `SecretReveal.tsx:22-25` swallows a clipboard failure while `useCopyFeedback` is used five lines away in the same modal (`MigrationKit.tsx:20`); backdrop click destroys it; no Escape, no focus trap, `role="dialog"` on the backdrop with no name. And `mintKey.ts:48` persists the first-sign-in key's PLAINTEXT to localStorage (deliberate, commented, cleared on sign-out) while the modal promises "the only time the full secret is shown" — false for exactly that key. → [[secret-not-losable]]
- **Nothing states the deployment's security posture**: with `TTS_API_KEY` unset (`auth.py:34-35`) the service accepts everything and every minted key enforces nothing; nor is it said that setting one closes `/docs` and gates `/metrics` (round 6). → [[deployment-posture-truth]]
- **The compatibility check verifies a path the user will not use**: it routes through `/api/tts` to dodge CORS and goes emerald, while the JS snippet it hands you (`switchkit.ts:162-172`) is a browser fetch that dies at preflight under round 6's default-closed CORS. Failure rendered amber where rose means failed; backend detail discarded. → [[compat-check-real-path]]
- **Zero tests** on `web/app/keys/**` and `web/app/api/keys/**`; `switchkit.ts` (rendered in three places) has none either. `deleteKey` is the only mutation with no in-flight gate and no `useMounted` guard; the empty state can stack "No keys yet" on a real error. → [[keys-surface-tested]]
- Not taken: three divergent clipboard implementations reachable from this flow where one hook exists; nav module list duplicated (`AppFrame.tsx:12-16` / `StudioDark.tsx:16`); `auth.py:20` docstring omits the `performance` scope (folded into [[deployment-posture-truth]]); a11y — scope pills with no `aria-pressed`, unlabelled per-row actions, empty actions `<th>`, loading row with no `aria-live`.

## Direction history
2026-07-29 (round 8) — proposed 5, **all 5 accepted**: revoke-not-destroy ✅ secret-not-losable ✅ deployment-posture-truth ✅ compat-check-real-path ✅ keys-surface-tested ✅. The unreachable revoke endpoint had been flagged in four consecutive session wraps before this context was finally cursored.

## Shipped
Round 8 (2026-07-29) — all 5:
- [[revoke-not-destroy]] → **1796604** — the `revoke` button called DELETE. Split into revoke (POST, key stays listed and struck through) and destroy, with a proxy route mirroring the backend path 1:1, and per-verb rollback copy.
- [[secret-not-losable]] → **d66ac19** — "the only time the secret is shown" was false while `mintKey.ts` persisted it. Kept the storage, made the copy true, labelled a recalled secret as recalled.
- [[deployment-posture-truth]] → **f2752a2** — `enforced` / `unknown` / `unreachable`, where a served key list proves NOTHING (the proxy attaches its own key) and so renders as a warning rather than a guess.
- [[compat-check-real-path]] → **41cfd91** — the green tick names the path it checked; the JS snippet carries its CORS caveat inline; a failed check shows the backend's own detail in rose.
- [[keys-surface-tested]] → **69c4d8e** — first tests for the surface (3 files), which found the `useCopyFeedback` falsy-default bug affecting seven unrelated surfaces.

**Open**: an unauthenticated server-side probe route would turn `unknown` into a real answer (open vs keyed-and-authorised). K2's follow-up; banked for round 9.
