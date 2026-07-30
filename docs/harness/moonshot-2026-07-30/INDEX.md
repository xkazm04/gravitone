# Moonshot Scan — Gravitone, 2026-07-30

> Scan agent: `moonshot-architect` (Opus subagents, 1 per context, 2 proposals each).
> 17 scan units = 14 mapped contexts (web paths corrected `gravitone-web/` → `web/`) + 3 ad-hoc units
> for surface unmapped since the 2026-07-15 merge (Conversational AI, Dialog Brain & Engines, Sharing/Packs).
> **34 moonshots: 26 Tier-1 / 8 Tier-2.** No baseline captured (scan-only; proposals, not defects).

## Totals

| | Tier 1 (10x) | Tier 2 (3-5x) | Tier 3 | Total |
|---|---:|---:|---:|---:|
| Across 17 units | 26 | 8 | 0 | **34** |

Feasibility: 13 high / 21 medium. Horizon: 10 weeks-class / 24 months-class.

## All 34 — by theme

### A. Measured voice intelligence (the system hears itself) — 9 items
The strongest convergence of the scan: **5 independent scanners** discovered that the speaker-embedding
extractor (CAM++ via sherpa-onnx, already vendored for diarization) and the local word-timestamp ASR
(built for convai) are unexploited on the synthesis/cloning side.

1. **Fidelity Loop** — ingest hears its own clone, prunes outlier segments, optimizes identity match. T1/high/weeks. `cloning-ingest.md`
2. **Voice Corpus** — stop GC'ing ingest workdirs; durable per-character corpus enables re-derivation + cross-take top-up. T1/med/months. `cloning-ingest.md`
3. **Audition Room** — synthesize candidate voices from multiple stem recipes, blind A/B, commit the winner. T1/med/months. `voice-creation-studio.md`
4. **Segment Casting Board** — expose per-segment labels; editable stems, pooled segments per character. T2/med/months. `voice-creation-studio.md`
5. **Emotion Algebra** — derive missing emotions from shared (emotion − baseline) embedding residuals. T1/med/months. `voice-emotion-library.md`
6. **Measured Emotion Space** — prosody probe replaces hardcoded fallback chain; continuous emotion addressing. T2/high/weeks. `voice-emotion-library.md`
7. **Voice Algebra** — transplant emotion deltas across the roster; "derive from…" on empty rack slots. T1/med/months. `character-voice-management.md`
8. **Fidelity Ledger** — every Voice carries a measured quality score; roster audits itself. T2/high/weeks. `character-voice-management.md`
9. **Verified Speech** — the synthesis API listens to its own output (ASR round-trip verification). T1/med/months. `speech-synthesis-api.md`

### B. Live conversation (surface the hidden convai layer) — 5 items
10. **Conversation Gym** — replayable, self-generated voice-agent CI over the convai protocol. T1/high/months. `conversational-ai.md`
11. **Zero-gap turn-taking** — speculative answer before the caller stops talking. T1/med/months. `conversational-ai.md`
12. **Table Read** — playground gains a live, interruptible rehearsal mode; rehearsal becomes script + takes. T1/med/months. `tts-playground.md`
13. **Punch-in timeline** — segment/word-level retakes spliced client-side; takes become editable. T1/high/weeks. `tts-playground.md`
14. **Polyglot Turn** — directing brain follows the speaker into another language mid-call, one character identity. T1/med/months. `dialog-brain-engines.md`

### C. Platform & federation — 6 items
15. **Speech Engine Plane** — capability-declared engine adapters + conformance kit + /v1/engines. T1/high/months. `dialog-brain-engines.md`
16. **Characters as content-addressed URIs** — registry-less voice federation; any static host publishes voices. T1/med/months. `sharing-packs-distribution.md`
17. **Speech as a build artifact** — content-addressed synthesis + incremental POST /v1/build. T1/high/months. `speech-synthesis-api.md`
18. **In-Browser Engine** — WASM/ONNX client-side synthesis on the landing page (also kills hero-demo abuse risk). T1/med/quarters. `app-shell-landing.md`
19. **Key-as-Handshake** — one paste turns a key into a self-configuring agent integration. T2/med/months. `api-key-management.md`
20. **Audible Docs** — the shell narrates itself; /v1/narrate URL-to-audio becomes a product. T2/high/weeks-months. `app-shell-landing.md`

### D. Trust & identity — 5 items
21. **Voiceprint Registry** — enroll your voice once; no other account can clone it. T1/med/months. `auth-profile.md`
22. **Speaker Sign-Off** — consent as a two-party revocable protocol; every clone invites the speaker (viral loop). T1/high/weeks→months. `auth-profile.md`
23. **Proving Ledger** — every key ships with an empirically proven least-privilege matrix. T1/high/weeks. `api-key-management.md`
24. **Sealed Appliance** — air-gapped, weights-baked, attested single artifact (found: Dockerfile omits faster-whisper/sherpa-onnx/piper — convai layer absent from every deploy path). T1/med/months. `packaging-deployment.md`
25. **Voiceprint Sigils** — glyph derived from the voice embedding; public /v1/voices/{id}/sigil.svg identity asset. T1/med/months. `emotion-glyph-art.md`

### E. Performance & ops truth — 5 items
26. **Deadline Contract Engine** — cost-model admission with predicted wait, deadline-ordered queue, elastic quality instead of 429. T1/med/months. `concurrency-engine.md`
27. **Gravitone Fabric** — N blind replicas become one addressable cluster (affinity routing, fan-out, rolling drain). T1/med/months. `concurrency-engine.md`
28. **Arm Performance Ledger** — signed cert time series + first CI; perf regressions gated per Arm uarch; generates the hand-transcribed benchmarks.ts. T1/med/months. `loadtest-certification.md`
29. **SLO Capacity Contract** — open-loop Poisson load model; certificate asserts sustained users at p95 SLO. T1/high/weeks→months. `loadtest-certification.md`
30. **Deployment Compiler** — the artifact measures the box and writes its own topology from certificates. T2/high/weeks. `packaging-deployment.md`

### F. Studio craft & design — 4 items
31. **Signal Layer** — one audio-reactive token bus (AudioBus → CSS vars) every primitive reads; today all "audio" visuals are fake CSS keyframes. T1/high/weeks. `ui-design-system.md`
32. **Score view** — Track/Region/Playhead primitive grammar makes the emotion-tag grammar visually editable. T1/med/months. `ui-design-system.md`
33. **Emotion coordinate space** — valence/arousal/intensity as single source of truth for hue, geometry, fallback. T2/high/weeks. `emotion-glyph-art.md`
34. **Re-performable takes** — every share is a fork point; direction-delta corpus feeds preferred(). T2/high/weeks. `sharing-packs-distribution.md`

## Conversion sequence (not fix-waves)
Moonshots convert to Pipeline-A goals one at a time. Natural stacks if accepted together:
- **A-stack**: Fidelity Loop → Fidelity Ledger → Audition Room / Voice Corpus (each builds on the embedding measurer).
- **B-stack**: Table Read needs the convai layer surfaced; Punch-in is independent (weeks-class).
- **E-stack**: SLO Capacity Contract → Arm Performance Ledger (ledger stores the new cert format).

## Provenance
17 Opus subagents, ~160 files read total, guardrailed against the 33 shipped ideas (2026-07-10 campaign),
the 9 rejected clusters (metering/billing, capacity tiers, pricing page, cast cloning, white-label), and
`followups-2026-07-10.md` deferred items. Counts verified: 34 `## M` headers = 17 files × 2.
Triage status recorded below after user review.

## Triage (2026-07-30)

Multi-select triage with the user, 3 rounds. **30 accepted / 4 rejected.** All 34 persisted to the
Vibeman ideas DB (scan `3ae32e8b-e6d4-4290-8039-f9b6659f6567`, scan_type `moonshot_architect`) with
statuses, effort/impact/risk, and context links.

**Rejected** (with feedback recorded): Characters as content-addressed URIs, Voiceprint Registry,
Emotion coordinate space, Voiceprint Sigils. Pattern: identity/federation-flavored items.

**Accepted (30)** — everything else, including ALL of themes A1 (clone quality), A2 (emotion math),
B (live conversation), and E (perf/ops truth). Note: user accepted BOTH Emotion Algebra and Voice
Algebra despite overlap — merge into one goal at conversion time.

Conversion note: these are goals, not fix-waves. Weeks-class quick starts among the accepted:
Fidelity Loop, Punch-in timeline, Proving Ledger, Measured Emotion Space, Fidelity Ledger,
Deployment Compiler, Signal Layer, Re-performable takes, Speaker Sign-Off (v1), SLO Capacity Contract (v1).
