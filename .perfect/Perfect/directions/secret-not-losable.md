---
slug: secret-not-losable
type: perfect/direction
context: "[[API Key Management]]"
lens: robustness
status: shipped
size: M
proposed: 2026-07-29
accepted: 2026-07-29
shipped: 2026-07-29
commit: d66ac19
---
## What & why
On the one screen where losing the text is unrecoverable, the secret reveal swallows a clipboard failure and leaves the button reading "copy". `useCopyFeedback` — the repo's answer to exactly this — is in use five lines away in the same modal tree. Clicking the backdrop dismisses the dialog and destroys the once-only secret with no confirmation; there is no Escape handler, no focus trap, no initial focus, and `role="dialog"` sits on the backdrop with no accessible name. Separately the modal promises "the only time the full secret is shown" while the first-sign-in key's plaintext is persisted to `localStorage` and re-displayed indefinitely — a deliberate, commented tradeoff, but it makes the promise false for exactly one key with no way for the user to tell which.

## Evidence
- `web/app/keys/_variants/SecretReveal.tsx:22-25` — `catch { /* ignore */ }` around `navigator.clipboard.writeText`; `:50` the label never changes.
- `web/lib/useCopyFeedback.ts:18-51` exists for this; `web/app/keys/_variants/MigrationKit.tsx:20,86` uses it correctly ("copy blocked — select it") inside the same modal.
- `SecretReveal.tsx:33` — the backdrop carries `role="dialog" aria-modal="true"` AND the click-to-dismiss handler; no `aria-labelledby`, no focus trap, no initial focus, no keydown listener anywhere in the file.
- `web/lib/mintKey.ts:48` — `localStorage.setItem(slot(uid), JSON.stringify({ secret: k.secret, prefix: k.prefix }))` (Director-verified); `:28-32` clears it on sign-out; `UserMenu.tsx:75-79` and `profile/page.tsx:133` re-display it.
- `SecretReveal.tsx:43` — "This is the only time the full secret is shown."
- Third divergent clipboard behaviour: `profile/page.tsx:24` destructures `{ copy, copied }` and drops `failed`, so `:135` and `:147` no-op silently; `UserMenu.tsx:78` gets it right.

## Acceptance criteria
- A refused clipboard says so, through the shared hook — no surface in this flow claims a copy that did not happen.
- The secret cannot be dismissed by an accidental click; closing it is deliberate.
- The dialog is keyboard-dismissible, focus-trapped, and has an accessible name; the dialog role sits on the dialog, not the backdrop.
- The "shown once" copy is TRUE everywhere it appears — either the stored key is exempted in the copy, or the storage is reconsidered; whichever is chosen is stated in the code.
- The three divergent clipboard implementations reachable from this flow converge on the one hook.

## Risks / non-goals
- The `localStorage` decision is a considered tradeoff with a comment explaining it (it powers "copy my key" from the profile) — do not silently reverse it. If it stays, the promise must change; if the promise stays, the storage must. Say which and why.
- Non-goal: redesigning the reveal modal's layout or the migration kit.

## Build record
Builder K1. `SecretReveal` said "this is the only time the full secret is
shown" while `mintKey.ts:48` persisted it to `localStorage` — the copy was
false and the storage was the greater sin. Kept the storage (losing a secret to
a refresh is a real harm) and made the copy true, plus `isStoredSecret()` so a
recalled secret is labelled as recalled rather than posing as fresh.
