---
slug: revoke-not-destroy
type: perfect/direction
context: "[[API Key Management]]"
lens: feature
status: shipped
size: M
proposed: 2026-07-29
accepted: 2026-07-29
shipped: 2026-07-29
commit: 1796604
---
## What & why
The studio's kill button says "revoke" and destroys the key. `POST /v1/keys/{kid}/revoke` has existed since round 4 — non-destructive, keeps the key listed and auditable, 409s a later rotate — and is unreachable from the studio: the proxy has only POST-as-rotate and DELETE. So the single action a user has for a leaked credential erases its audit identity, which the backend's own module docstring calls the wrong tool for a leak. There is no confirmation on it. And `revoked` is typed and never read, so a revoked key renders byte-identical to a live one — same styling, same enabled rotate.

## Evidence
- `service/keys.py:274-296` — the revoke endpoint; `:15-19` — "DELETE still exists, but it destroys the audit identity" and is the wrong tool for a leak.
- `web/app/api/keys/[id]/route.ts:6-9` POST→rotate, `:11-16` DELETE. **No handler contains `/revoke`** anywhere in `web/`. (Director-verified.)
- `web/app/keys/_variants/KeysLedger.tsx:115` — `onClick={() => deleteKey(k.id)}` on a button labelled **revoke**. (Director-verified.)
- `web/app/keys/_variants/data.ts:82-101` — `deleteKey` issues DELETE; its failure copy reads "revoke failed (…) — the key is still active".
- `data.ts:15` — `revoked` typed, never read; `KeysLedger.tsx:87-95` renders name/key/scopes/created/last-used and no state.
- The right pattern is already in-repo: `web/app/profile/MyVoices.tsx:92-111` renders revoked items dimmed, struck through, actions disabled.
- `.claude/CLAUDE.md:66-68` cites `data.ts::deleteKey` as the canonical optimistic-rollback example — the doctrine is anchored on the function with the wrong verb.

## Acceptance criteria
- Revoke is reachable and is the DEFAULT kill action for a leaked key; destroy remains available, explicitly labelled as destructive, and confirmed.
- A revoked key is visually and semantically distinct from a live one, reusing the `MyVoices` pattern rather than inventing a second.
- Rotating a revoked key surfaces the backend's 409 (which states the reason) — reachable now that the UI can produce a revoked key.
- Every button label matches the request it sends, and the failure copy names the true state.
- The CLAUDE.md reference is updated alongside, since it points at this function by name.

## Risks / non-goals
- Do not remove DELETE — destroying a key is legitimate; it just must not be the only option or the one labelled "revoke".
- The ledger must keep showing revoked keys (that is the point of revoke); make sure filtering/sorting does not hide them.
- Non-goal: key expiry/TTL, per-key rate limits, or usage accounting (billing-flavoured; declined in round 1).

## Build record
Builder K1. The ledger's `revoke` button issued `DELETE` — it destroyed the
row it claimed to revoke, so the audit trail the surface advertises never
existed. Split into `revokeKey` (POST `/v1/keys/{id}/revoke`, key stays listed
and struck through) and `destroyKey`, with a new proxy route mirroring the
backend path 1:1. Rollback copy differs per verb: "the key is still active" vs
"the key still exists" — the two failures leave different worlds behind.
Director verified the defect at `KeysLedger.tsx:115` before briefing.
