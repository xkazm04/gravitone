---
slug: compat-check-real-path
type: perfect/direction
context: "[[API Key Management]]"
lens: robustness
status: shipped
size: S
proposed: 2026-07-29
accepted: 2026-07-29
shipped: 2026-07-29
commit: 41cfd91
---
## What & why
The migration kit's "run compatibility check" deliberately routes through the studio's own proxy so it works without CORS, and reports a green "ElevenLabs-shaped request served" — while the JavaScript snippet in the same panel is a browser `fetch` straight at the deployment host, which on a default deployment dies at preflight because round 6 shipped CORS default-closed. The check goes green for a path the user will not use, sitting next to the code that will fail.

## Evidence
- `web/app/keys/_variants/MigrationKit.tsx:32-33` — comment: routed "via the studio proxy, so it works from the browser without CORS"; `:34-55` the check; `:94-97` the emerald success.
- `web/lib/switchkit.ts:162-172` — the JS snippet is a direct browser `fetch` at the deployment host.
- `service/app.py` CORS is default-closed (round 6, `0e4d82f`) — no `TTS_CORS_ORIGINS` means no middleware at all.
- `MigrationKit.tsx:100` renders a FAILED check in amber; `components/ui/ErrorBanner.tsx` and `.claude/CLAUDE.md:64-66` reserve rose for failure, amber for degraded.
- `MigrationKit.tsx:42-45` never calls `readDetail`, so the backend's own message is discarded and everything non-OK collapses to `upstream {status}`.

## Acceptance criteria
- The check either exercises the same path the copied snippet uses, or states plainly which path it verified and what that does not prove.
- The snippet and the check agree about whether a browser can reach this deployment; a user is not handed code that cannot work next to a green tick.
- A failed check is rose and carries the backend's own message.
- Nothing here weakens CORS to make the snippet work — the default-closed posture is correct and was chosen deliberately.

## Risks / non-goals
- Do not "fix" this by loosening CORS; the fix is telling the truth about what was checked.
- Non-goal: rewriting the snippet catalogue or adding new languages.

## Build record
Builder K2. The migration kit's green tick meant "the deployment served an
ElevenLabs-shaped request server-to-server through our proxy" and was sitting
next to a JavaScript snippet that dies at the CORS preflight on a default
deployment. The check now names the path it checked, the JS snippet carries the
caveat inline, and a failed check shows the backend's own detail (a 401 naming
the missing scope is the whole diagnostic value) in rose rather than collapsing
to amber `upstream {status}`.
