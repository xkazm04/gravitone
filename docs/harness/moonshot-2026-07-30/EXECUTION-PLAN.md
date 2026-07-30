# Moonshot Execution Plan — batches of 5, parallel Opus builders

29 work items (Emotion Algebra + Voice Algebra merged) from the 30 accepted moonshots.
Each batch: design doc → 5 parallel Opus builders with hard file ownership → orchestrator
integrates, runs full gates, commits per feature. Branch per batch: `vibeman/moonshot-batch-N`.

| Batch | Name | Items | Rationale |
|---|---|---|---|
| 1 | **The Studio Hears Itself** | Fidelity Loop · Fidelity Ledger · Measured Emotion Space · Audition Room · Signal Layer | Highest-convergence theme (5 scanners), mostly weeks-class; delivers the measurement substrate later batches reuse + the audio-reactive visual foundation. |
| 2 | **The Living Stage** | Table Read · Punch-in Timeline · Zero-gap Turn-taking · Conversation Gym · Polyglot Turn | Surfaces the entire hidden convai layer as one comprehensible package. |
| 3 | **Proof & Trust** | Proving Ledger · Speaker Sign-Off · Verified Speech · SLO Capacity Contract · Sealed Appliance | Everything the product claims becomes proven; fixes the Dockerfile convai-deps gap via Sealed Appliance. |
| 4 | **The Platform Plane** | Speech Engine Plane · Speech as Build Artifact · Key-as-Handshake · Audible Docs · Deployment Compiler | API-facing platform verbs. |
| 5 | **Scale & Memory** | Deadline Contract Engine · Gravitone Fabric · Arm Performance Ledger · Voice Corpus · Re-performable Takes | Throughput truth + durable corpus (Voice Corpus benefits from B1 fidelity). |
| 6 | **Expression Frontier** | Emotion/Voice Algebra (merged) · Score View · Segment Casting Board · In-Browser Engine | The riskiest derivations last, atop B1's measurement + Signal Layer. |

Rules (all batches):
- Builders NEVER run git; orchestrator reviews diffs and commits per feature.
- Hard file-ownership matrix per batch; cross-feature hooks are specified as exact
  signatures in the design doc and implemented by the owning agent.
- Gates: full service unittest loop (all modules, `python -m unittest service.tests.<mod>`),
  web `tsc --noEmit` + `vitest run` + `next build`. Baseline captured before each batch.
- UX bar: one visual vocabulary per batch (defined in the design doc); no raw browser
  chrome; measured data shown as named facts, never opaque scores; absent data renders nothing.
- After each batch: FIXES/summary doc, ideas marked implemented in Vibeman DB, memory updated.
