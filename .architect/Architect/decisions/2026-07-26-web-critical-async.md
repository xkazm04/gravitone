---
date: 2026-07-26
slug: web-critical-async
status: in-progress
type: structural-bug-class
reach: "5 sites: keys rotate, 2 dropped consent receipts, preview URL leak, 2 stuck players, 1 false success"
risk: 2
effort: s
payoff: 4
branch: "(committed to main)"
related_scan: "[[Architect/scans/2026-07-26-async-patterns]]"
---

# Web critical async holes

## Context
- **Key rotate had no in-flight guard** (`KeysLedger.tsx:96`) while create,
  upload, share, commit, scan, clone and mint all do. A double-click fires two
  `POST /api/keys/{id}`, minting two secrets where the second invalidates the
  first and the reveal modal shows whichever resolved last — the one place a
  duplicate request is a security-relevant artifact.
- **`recordVoiceOwnership`'s `{saved, failed}` result was dropped at 2 of 3
  call sites** (`characters.ts:279`, `CharacterTable.tsx:163`). `voiceVault.ts`
  was rewritten to return it "so the caller can surface 'consent receipt not
  saved' instead of losing it silently"; only the ingest page honored it. A
  clone succeeds, its provenance record fails, nobody is told.
- **`useVoicePreview` leaked object URLs**: no mounted guard, so a preview that
  resolved after unmount created a URL the (already-run) cleanup never revokes.
- **Stuck players**: `void a.play()` with optimistic state in `TakeCard.tsx:86`
  and `voices/new/page.tsx:139` — the shape `useAudioPlayer` was fixed for
  earlier today.
- **False success**: the playground share button claimed "✓ link copied" after
  a denied clipboard permission.

## Decision
Per-site minimal fixes, reusing the patterns the codebase already proves:
rotate gets a `rotating` id gate + "rotating…" label; both vault call sites
await the result and surface a `severity="warning"` ErrorBanner (the receipt
failed, the voice exists — not an error); `useVoicePreview` gets a `mounted`
ref checked after every await, revoking the URL it just minted if teardown
already happened; both players await `play()` and reset (TakeCard also sets its
`audioErr` label); share tracks `copyFailed` per take and renders
"published — copy failed".

## Consequences
Positive: no duplicate key mint; consent-receipt loss is visible everywhere it
can happen; no leaked blob URLs; no player stuck in a fake playing state; the
share button stops lying.
Negative/risks: `useCharacter` grows a `vaultWarning` field (additive);
CharacterTable renders a second banner below its error one.
Mitigations: tsc clean; behavior changes are all in the failure direction.

## Rollout
1. All five fixes — `npx tsc --noEmit` clean. ✅

## Acceptance criteria
- Rotate is disabled while in flight and surfaces backend detail on failure. ✅
- Both vault call sites render a warning when `failed > 0`. ✅
- Preview revokes a URL minted after unmount. ✅
- Both players reset on a rejected `play()`. ✅
- Share distinguishes published-and-copied from published-only. ✅

## Regression checklist
- [x] tsc clean.
- [ ] Manual: double-click rotate, deny clipboard, block Firestore, expired share — UNVERIFIED (no dev-server session).
