---
slug: premium-format-in-console
type: perfect/direction
context: "[[TTS Playground]]"
lens: feature
status: shipped
size: M
proposed: 2026-07-28
accepted: 2026-07-28
shipped: 2026-07-28
commit: 2400f6b
---
## What & why
Round 6 gave `/v1/speak` and `/v1/performance` the full `output_format` grammar, and the console cannot reach it. The proxy has no query-forwarding parameter at all and hardcodes `Content-Type: audio/wav`, so even a requested mp3 would arrive mislabelled. Meanwhile the UI asserts the limitation back at the user — "exports 24kHz wav", a hardcoded `.wav` download, and a code export that teaches neither parameter — while the switch-kit already teaches `?output_format=mp3_24000_128` for the drop-in route. The user moment: sharing a multi-character performance as a small mp3 instead of a many-megabyte wav, which is what round 6's own commit named as the point of the change.

## Evidence
- `service/app.py:1250` and `:1345` — `output_format: str = Query("wav_24000")` on both routes.
- `web/app/playground/_variants/engine.ts:274` and `:327` — bare POSTs, no query string.
- `web/lib/backend.ts:85-118` — `proxyWavPost` takes no query parameter; `:112` hardcodes `Content-Type: audio/wav`. (Director-verified.)
- `web/app/playground/_variants/PlaygroundConsole.tsx:1141` — "exports 24kHz wav"; `:1309` — hardcoded `.wav` download.
- `web/app/playground/_variants/TakeCode.tsx:44-77` — emits `--output take.wav` with no `output_format`, for the two routes that now support it.
- `web/lib/switchkit.ts:145` — already teaches `?output_format=mp3_24000_128`, but only for `/v1/text-to-speech`.

## Acceptance criteria
- Format flows console → proxy → service, with query forwarding added to `proxyWavPost` itself rather than bolted onto one route.
- The response's `Content-Type` reflects the format actually returned.
- Download and share honour the chosen format, including the file extension.
- The code export teaches the parameter the target route now supports.
- `wav_24000` remains the default, so every existing call is byte-identical.
- The format choice is presented where the user decides to keep a take, not buried in settings.

## Risks / non-goals
- `proxyWavPost` is shared with other callers — adding query forwarding must not change behaviour for anyone who passes nothing.
- Non-goal: mp3 on a streaming route (still 501 by design), or exposing every format permutation in the UI — pick the few that matter and say why.

## Build record
Builder P1. Query forwarding lives in `proxyWavPost` itself (`opts.forwardQuery`); both premium routes allowlist only `output_format`, and no allowlist / no param yields a byte-identical upstream URL (tested). Content-Type now echoes upstream (`audio/mpeg` for mp3) instead of the hardcoded `audio/wav`. New `web/lib/audioFormats.ts` offers two formats — `wav_24000` (default, unchanged) and `mp3_24000_128` — with the rationale in-file: the studio is where you decide what to KEEP, so the rest of the grammar (pcm, other rates) stays a producer concern reachable through the code export, which now emits `?output_format=…` and `--output take.mp3`. The format toggle sits beside Generate, not in settings. `Take.format` persists through IndexedDB; download filename/extension/label, share upload filename and the snippet all follow it.

**HONEST INCOMPLETENESS, and the right call.** `service/takes.py:72` hard-rejects any non-RIFF upload (Director-verified), so an mp3 take cannot become a Voice Card or a client-review link. Rather than let a user render an mp3 and then eat a 400 at upload, the builder DISABLED share and review for mp3 takes with an explicit reason ("Voice Cards are published as wav — re-render this take as wav to share it") and recommended teaching `takes.py` mp3 in a future round. So mp3 today is **download + code export, not sharing** — which means the direction's headline user moment ("share a performance as a small mp3 LINK") is only partly delivered. Director accepted the containment rather than rushing a cross-surface change (takes storage + the `/t/{id}` player + review) at merge time; **banked as a round-8 candidate.**

**Director review**: gates on main — tsc clean, 170 web tests / 17 files at merge, 191 after the wave. MERGED.
