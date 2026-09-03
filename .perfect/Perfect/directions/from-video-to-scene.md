---
slug: from-video-to-scene
type: perfect/direction
context: "[[Voice Cloning & Ingest Pipeline]]"
lens: wildcard
size: M
status: shipped
proposed: 2026-08-06
accepted: 2026-08-06
shipped: 2026-08-07
commit: b612a61
---
## What & why
Close the loop: after casting Characters from a video, one click opens the playground in script mode with the scene pre-filled — the diarized transcript's lines, each assigned to its newly-cloned Character. The demo becomes: paste a link → cast the speakers → re-perform the actual dialogue in their cloned voices → edit the lines. Transcript text per speaker segment already exists in the analysis artifacts; script mode's per-line character model is exactly this shape.

## Evidence
- `build_segments` merges Scribe words keyed by `speaker_id` with text (`ingest.py:933-951`); `segments.json` persists in the workdir.
- `ScriptLine {id, characterId, text}` (`web/app/playground/_variants/shared.ts:47`); ≤64 lines, ≤8000 chars/line (`shared.ts:495-497`).
- Composer persistence: `composerStore` (`web/lib/composerStore.ts:16-23, 42-71, 106`).

## Acceptance criteria
- "Open as scene" affordance from the completed cast; lines mapped to the correct committed Characters (speaker→character mapping from the casting step).
- Consecutive same-speaker segments merged into natural lines; >64 lines truncated with copy that says so.
- Hand-off via existing composer persistence — no new storage contract, no new share type.
- Uncast speakers' lines handled deliberately (assigned to a cast character or omitted, stated in the UI).
- Transcript availability failure honest: no transcript → the affordance explains why, not a dead button.

## Risks / non-goals
- Cross-context seam with TTS Playground (composer prefill): the ingest builder writes composer state ONLY via the exported store API; any playground-side change is a named DECISION-NEEDED.
- Sovereign path may lack word-level transcripts — feature may be cloud-mode-only at first; copy must say so.
- Non-goal: audio re-sync/timing of original video; emotion auto-tagging of the scene (that's [[director-suggests-spans]]'s machinery, future compose).

## Build record
Builder V-B → 8350301, picked as **b612a61**. `GET /v1/ingest/{job}/scene` (build_scene: consecutive same-speaker merge; an uncast speaker's turn BREAKS the merge — builder caught its first version fabricating one continuous utterance across an omitted answer; uncast omitted + counted; 64-line cap names both numbers). Hand-off = OpenInRack's exact pattern: one saveComposer + router.push — zero playground changes, sceneComposer output pinned against sanitizeComposer in a test. Deleted-character handling VERIFIED not invented (playground's reconcileCharacters remaps + prints missing ids). Unavailability always a service sentence (sovereign/no-transcript, swept workdir, nobody finished, fetch failed) — no dead buttons. Director gates: same wrap run as 0a6c1d5. Verdict: merge.
