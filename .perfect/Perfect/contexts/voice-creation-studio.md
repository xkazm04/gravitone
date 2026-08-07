---
name: Voice Creation Studio
type: perfect/context
group: Web Studio
category: ui
opportunity: 8
last_proposed: 2026-07-28
cooldown_until: round 8
directions: ["[[truthful-pipeline-feedback]]", "[[create-flow-state-machine]]", "[[preview-poll-efficiency]]", "[[onpage-recorder]]", "[[clip-quality-preflight]]", "[[backend-truth-reaches-user]]", "[[stop-saying-false-things]]", "[[retry-not-failure]]", "[[flow-state-truth]]", "[[scan-cost-visible]]"]
---
## Current state (RE-SCOUTED 2026-07-28, round 6 — the round-2 brief was superseded)
Re-scouted because round 5 rewrote this context's entire backend the day before. Score raised 7.5 → 8: round 5 created a large, concrete surfacing opportunity that did not exist when the old score was set.

Single mount (`page.tsx:22`), one loader (`WaveformLab`), 7-phase reducer (`_state/machine.ts`), one poller (`_state/useIngestJob.ts`) with step-keyed backoff 1.5/3/5s and stall-after-3. Proxy routes are thin; `proxyJson` passes upstream status through verbatim and preserves `Retry-After` (`lib/backend.ts:72-73`). Round-2 work all CONFIRMED live: truthful-pipeline-feedback (headline from server steps only), create-flow-state-machine (one reducer, one statusToPhase), preview-poll-efficiency (step-keyed backoff, immutable-cached previews, one shared audio element).

**THE FINDING OF THIS ROUND — round 5's new truth dies at the API boundary.** `_analyze` persists only `speakers` and `duration` (`ingest_api.py:388`); `note`, `limits` and `detection` are computed and dropped, and `_PUBLIC_KEYS` (`:537`) has no slot for them. (Director-verified.) `spend` DOES cross (published on `partial`) but the web `Partial` type has no field for it.

Rough (Director-verified where load-bearing):
- **The UI states the opposite of the code**: "failed segments fell back to the baseline stem" (`page.tsx:303`, `WaveformLab.tsx:91`) vs `ingest.py:1118-1121` "an unlabelled segment is UNUSED, not baseline audio" + the `usable` filter at `:1177`. → [[stop-saying-false-things]]
- Sovereign limits hand-mirrored as prose (`page.tsx:248`) instead of consuming `SOVEREIGN_LIMITS`; `auto`-resolved-to-sovereign shows none of them; the `unbroken` detection finding renders as an italic QUOTATION, styled as transcript (`page.tsx:284`). → [[backend-truth-reaches-user]]
- Round 5's 429 admission cap renders as a rose failure banner; no branch on 429 anywhere despite the playground doing it correctly. `submitting` is a REF so no button has a pending state (120s scan timeout). Client validation mirrors the backend BY HAND (`page.tsx:523-530`) and missed the new duration ceiling; a null `probeDuration` is waved through where the backend now fails closed. → [[retry-not-failure]]
- Error transition keeps stale `result`/`jobId` (`machine.ts:127`); `RESET` keeps `committedCid` (`:181-190`); **zero tests anywhere under `web/app/voices/new/**`** though `machine.ts` is a pure reducer. → [[flow-state-truth]]
- Not taken: the poll returns the WHOLE job every tick (`_PUBLIC_KEYS` includes `result` + 40 `segments`) to read three integers during commit, no ETag; `awaiting_speaker` polls at 5s indefinitely; a11y gaps (unlabelled name input + extend select, static "Play sample" aria-label, no table caption/scope, no `aria-live` on the processing headline, literal emoji); two JSX IIFEs that are really components; `shared.tsx:26` `LoaderData.duration` populated and never read; character-list fetch failure degrades to a silent empty state (`page.tsx:57`).

## Previous state (scouted 2026-07-13, round 2 — historical)
Seven-phase client state machine, WaveformLab with live emotion tally, speaker pick with previews, review ledger with keep/descope + consent gate, commit progress + cancel. Most of the round-2 "rough" list was fixed by round 2's own three directions.

## Direction history
2026-07-13 — proposed 5: truthful-feedback ✅ state-machine ✅ efficiency ✅ onpage-recorder ❌ preflight ❌.
2026-07-28 — proposed 5, **4 accepted**: backend-truth-reaches-user ✅ stop-saying-false-things ✅ retry-not-failure ✅ flow-state-truth ✅ · [[scan-cost-visible]] ❌ (the Spend ledger as UI — fourth cost/telemetry rejection; see the direction note and config.md → User taste).

## Shipped
Round 6 (2026-07-28) — 4/4:
- [[backend-truth-reaches-user]] → **463140d** — `note`/`limits`/`detection` now cross the API boundary; new `GET /v1/ingest/modes` serves the backend's own constants so the studio stops hand-copying them; detection outcomes read as findings, not transcript.
- [[stop-saying-false-things]] → **10684c3** — the "failed segments fell back to the baseline stem" claim (which the code comment directly contradicted) is gone, extract vs classify failures are named, the live tally stops counting failed segments as baseline, and the copy is mode-aware.
- [[retry-not-failure]] → **8f1918e** (+ Director **a58b37f**) — 429 is amber with a real countdown, every mutating button has an in-flight state, the upload mirror gained the duration ceiling.
- [[flow-state-truth]] → **86b77b6** — an error clears the state it invalidates, `RESET` fully resets, and the flow got its first 36 tests.

**Observed effect**: this flow went from zero tests to 36 (web suite 90 → 139 across the round), and round 5's sovereign work became visible to users for the first time.

## Round 10 (2026-08-04) — re-scout post-moonshot + slate
(Corrects stale round-6 note: ledger now has SegmentBoard + AuditionPanel drill-downs; _state/ machine.) Flow honest through most phases BUT: review unpolled → 30-min expiry kills job under a live-looking screen, no exit affordance; corpus opt-in/view/delete/rederive fully built server-side with ZERO web surface; per-stem identity + identity_reason + replaced die at the TS type boundary (extend-overwrite says nothing); streamIngestAsset flattens all asset errors to "not found"; two audio transports overlap; full-result polling with no ETag/visibility; no dynamic imports; 10 proxy routes zero tests.
Slate (ALL 5 ACCEPTED): [[the-corpus-door-opens]] [[fidelity-reaches-the-review]] [[review-doesnt-die-silently]] [[studio-polls-and-ships-less]] [[one-transport-in-the-lab]]
cooldown_until: round 12
