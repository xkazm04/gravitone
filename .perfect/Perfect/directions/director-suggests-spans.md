---
slug: director-suggests-spans
type: perfect/direction
context: "[[TTS Playground]]"
lens: wildcard
size: M
status: shipped
proposed: 2026-08-06
accepted: 2026-08-06
shipped: 2026-08-07
commit: 87603db
---
## What & why
One click — "direct this text" — and the server's already-shipped narration machinery (which emits emotion-tagged text today but has NO web surface; `POST /v1/narrate` is not even proxied) proposes emotion spans over the paragraph; the UI shows them as suggested regions the user accepts, tweaks, or rejects per-span. Combining emotions through a paragraph stops being manual bracket surgery and becomes review-and-adjust. Demo headline for the playground.

## Evidence
- `narrate.py:741` emits `block["tagged_text"] = f"[{emotion}]{block['text']}[/{emotion}]"`.
- Round-9 AND round-11 scouts: autofill has no web surface; `/v1/narrate` unproxied.
- Suggested-region rendering has prior art: per-region preview in `ScoreEditor.test.tsx:174-226`.

## Acceptance criteria
- Proxied endpoint follows the web proxy conventions (timeout, `throwDetail` error contract, streaming not required).
- Suggestions render as REGIONS (per [[one-emotion-model]]), visually distinct from user-applied spans; never auto-applied without review.
- Per-span accept / reject / re-emotion; accept-all affordance.
- Works in solo mode at minimum; suggestions limited to emotions the active character actually has, or clearly marked when they'd fall back.
- Failure honest: narrate error → banner, composer untouched.

## Risks / non-goals
- Depends on [[one-emotion-model]] — sequenced after it merges.
- Non-goal: script-mode multi-character narration casting (future slice).
- LLM latency: needs an in-flight gate + cancel, consistent with existing generation UX.

## Build record
PREMISE FALSIFIED by builder P-B: narrate's `[emotion]` tags come from a 5-entry `_ROLE` dict keyed on DOCUMENT STRUCTURE (narrate.py:409-415) — one user paragraph always returns one `[excited]` block; NO text→emotion inference exists anywhere in the service (direction.py = human-swap telemetry, prosody/ingest classify AUDIO, emotion_basis = embedding math). DECISION NEEDED → Director chose the sovereign rule-based first pass over a new LLM endpoint (deterministic, zero-config, matches repo posture; UI is the durable asset either way).
Shipped as 17e3643, picked as **87603db**. Client-side `suggest.ts`: `Director = (plain, vocabulary) => Suggestion[]` seam (heuristicDirector only impl; dialog.py ClaudeCliBackend + `[emotion:x]` grammar named in-file as the future candidate). 5 precision-ranked rules (parenthetical→whisper, capitals→angry, !→excited, ?→confused, …→sad), every suggestion carries its reason verbatim; copy states the METHOD ("from punctuation and phrasing — a first pass, not a reading") — 3 tests assert it never implies comprehension. Accept folds through `applyEmotion` one span at a time (byte-identical to hand-placed; refusals reported in the composer's own words); suggestions DROP when their text changes (a guess hasn't earned transformRegions). Ghosts = dashed text-decoration (shape difference, not opacity). Builder's tests caught 3 precision bugs pre-ship (lowercase continuation, acronym≠shout, MIN_SPAN 3→8). Watch item: one unreproduced 1-fail flake in a full-suite run (suspect ScoreText useLayoutEffect timing); 3 subsequent full runs + Director's main run all green. Verdict: merge.
