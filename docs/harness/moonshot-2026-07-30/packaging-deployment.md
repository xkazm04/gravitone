# Moonshots — Packaging & Deployment (2026-07-30)

Context: `Dockerfile`, `requirements.txt`, `deploy/` (bootstrap.sh, cloudformation.yaml,
aws-oneclick.sh, helm/gravitone/**), `docs/SUPPORTED_HARDWARE.md`, plus the referenced
runtime modules (`service/convai.py`, `stt.py`, `vad.py`, `piper.py`, `diarize.py`,
`certify.py`, `replicas.py`, `packs.py`).

Two grounding facts found while reading, both of which these proposals build on:

1. **The shipped image is not the shipped product.** `Dockerfile` installs only
   `pocket-tts fastapi uvicorn scipy psutil python-multipart`. `requirements.txt` — the
   real dependency set — additionally needs `faster-whisper`, `sherpa-onnx`, `piper-tts`.
   So a container built from this repo cannot listen, cannot diarize, cannot speak a
   non-English language, and `/v1/convai/*` is dead on arrival. Every deploy path
   (bootstrap → CFN → Helm) inherits that image, so the conversational layer exists in
   the codebase and nowhere in the deployable.
2. **Nothing in the artifact is offline.** `requirements.txt` says weights are "fetched on
   first use", `bootstrap.sh` says "first boot pulls weights, 1-3 min", diarizer models
   come from `python -m service.diarize --download`, Piper voices from
   `piper.download_voices`. The product's whole claim is sovereignty; the packaging
   requires egress to Hugging Face before it can say a word.

---

## M1. The Sealed Appliance — one air-gapped, attested artifact that speaks, listens and converses with the network unplugged

- **Tier**: 1 (10x category-defining)
- **Category**: platform
- **Impact**: Turns Gravitone from "software you install and hope stays local" into an
  auditable appliance whose *artifact itself* proves zero egress, complete capability, and
  measured capacity — the form regulated, classified, and disconnected buyers can actually
  accept.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: Sovereignty today is an architectural intention that the
  packaging contradicts — first boot phones out for four separate model downloads and the
  conversational half isn't in the image at all. Sealing it inverts the sales motion: the
  buyer stops auditing a running service over time and audits one immutable digest once,
  offline, with a machine-checkable manifest of what's inside. No hosted TTS competitor can
  hand over an artifact that works with the cable pulled, and every regulated segment that
  is closed to per-minute cloud speech opens at the same time.
- **Path to implementation**:
  1. **Fix the divergence and prove it in CI.** Make the `Dockerfile` install from
     `requirements.txt` instead of an inline hand-list, and add a test that imports
     `service.convai`, `stt`, `piper`, `diarize` inside the built image — the current gap is
     invisible precisely because nothing asserts the image can do what the repo does.
  2. **Add a bake stage.** A multi-stage build whose first stage runs each downloader
     (`faster_whisper` model fetch, `python -m service.diarize --download`,
     `piper.download_voices` for a declared locale set, the pocket-tts weights) into
     `/opt/gravitone/models`, then `COPY --from=bake` it into an immutable layer. Point the
     runtime cache env vars (HF_HOME, XDG_CACHE_HOME, `PIPER_VOICE_DIR`) at it and set
     `HF_HUB_OFFLINE=1` so a missing bake fails loudly rather than silently re-downloading.
  3. **Make "sealed" a gate, not a claim.** A CI job runs the whole flow —
     clone → synthesize → `/v1/speech-to-text` → a scripted convai turn — under
     `docker run --network none`. Any egress attempt becomes a build failure. This one test
     is the entire credibility of the tier.
  4. **Emit an appliance manifest.** Reuse the per-file sha256 + optional-HMAC canonical
     manifest pattern already proven in `service/packs.py` to write
     `/app/appliance.json`: image digest, model files with hashes and upstream provenance,
     locale/voice inventory, dependency SBOM, declared capability set. Serve it from
     `GET /v1/appliance` so a running box can be asked what it is.
  5. **Bind capacity to the artifact.** On first boot, run the existing
     `service.certify` flow once and fold the resulting certificate into the manifest, so
     the appliance reports *this digest, on this hardware class, sustains this cap* —
     turning `docs/SUPPORTED_HARDWARE.md` rows into artifact-level facts.
  6. **Ship the disconnected delivery form.** `docker save` a signed tarball plus an
     `airgap-install.sh` that loads it and registers the same systemd unit `bootstrap.sh`
     already writes — installation over a USB stick, no registry, no internet.
- **Dependencies**: buildx/QEMU or an Arm64 builder in CI (the base image is
  `armswdev/pytorch-arm-neoverse`, aarch64-only); a decision on which Piper locales bake in
  (image size grows with each); `service.certify` already exists and needs no change.
- **Risks**: image size — whisper int8 + sherpa diarizer + N Piper voices could push a
  multi-GB artifact, mitigated by a slim/full variant split (see M2's role images) and a
  small default locale set. Baked weights freeze upstream model versions, so the manifest
  must carry model versions and an update path. `--network none` CI needs the runner to
  permit it. Model licenses must be re-checked for redistribution inside an image (Piper is
  MIT, whisper/CT2 and sherpa models each need confirming) — this is a legal review step,
  not a code step.
- **What changes if we ship it**: The answer to "can this run in our disconnected facility?"
  becomes a file you hand over and verify, and the conversational agent finally exists in the
  thing customers actually run.

---

## M2. Deployment Compiler — the artifact measures the box and writes its own topology

- **Tier**: 2 (3-5x)
- **Category**: functionality
- **Impact**: One command on anything from a Pi 5 to a 192-core Ampere produces the
  *right* deployment — replica count, thread pinning, role placement, autoscaling metric —
  derived from a measured certificate instead of hand-tuned constants copied out of a README.
- **Feasibility**: high
- **Time-horizon**: weeks
- **Why it's a moonshot**: Every scaling fact this project learned the hard way is
  currently encoded as prose or as a default someone must remember to change:
  `bootstrap.sh` pins `WORKERS=1, THREADS=min(4,cores)` and runs exactly one container
  (so a c8g.2xlarge is deliberately 4x underused — a named follow-up), `values.yaml`
  hardcodes `replicaCount: 4` for one specific instance shape, and `deploy/README.md` warns
  in English that ingest is replica-affine and will 404 behind round-robin. All three are
  *computable* from facts the code already produces. Making topology a compiler output turns
  hardware diversity from a support burden into a feature — and it is the only credible way
  to claim "runs on any Arm box" without a per-box tuning session.
- **Path to implementation**:
  1. **Emit a plan from the certificate.** `service.certify` already records hardware facts,
     a healthy concurrency cap and a "recommended replica config". Add
     `python -m service.plan` that reads a certification (or runs a short probe) and writes
     `deployment-plan.json`: replicas, torchThreads, queueMax, resource requests, chosen
     autoscaling mode. Pure stdlib, no new deps, testable offline with fixture certificates.
  2. **Make bootstrap consume the plan.** Replace the fixed single-container systemd unit
     with `python -m service.replicas --replicas N` (the supervisor already does SO_REUSEPORT
     port sharing, thread pinning, restart-on-death and metric aggregation) using N from the
     plan — closing the "multi-replica fleet on big boxes" follow-up with code that exists.
  3. **Render deploy artifacts from the plan.** `service.plan --emit helm-values` and
     `--emit compose` so the Helm chart's `replicaCount`/`resources`/`keda.queuedTarget` and
     a docker-compose file both come from the same measurement — no more instance-specific
     defaults in `values.yaml`.
  4. **Introduce roles instead of one do-everything pod.** `synth` (stateless, scales
     freely), `converse` (needs STT+VAD+TTS co-resident and a latency budget), and `ingest`
     (replica-affine by design). Have the plan place them and have the chart template a
     StatefulSet-or-single-replica ingest role with session affinity, so the documented 404
     footgun becomes structurally impossible rather than a warning paragraph.
  5. **Role-scoped images.** Build `gravitone:synth` (no whisper/sherpa/piper layers) and
     `gravitone:full` from the same Dockerfile via build args — this is what keeps M1's sealed
     artifact from being gratuitously huge for pure-TTS fleets.
  6. **Publish a plan for every certified row.** Extend `docs/SUPPORTED_HARDWARE.md` so each
     hardware row links its generated plan — the community matrix becomes a library of
     ready deployments instead of a table of numbers.
- **Dependencies**: `service/certify.py` and `service/replicas.py` (both already built and
  load-tested); Helm chart templating changes; a short probe path for boxes with no prior
  benchmark run.
- **Risks**: an on-boot probe adds first-boot minutes and must be skippable
  (`PLAN=` override) or cached; a wrong plan is worse than a conservative default, so the
  emitter needs floors/ceilings and should refuse to plan from a failing certificate; role
  splitting multiplies the deploy surface and needs the M1 capability test per role image;
  SO_REUSEPORT-mode metrics are explicitly only a single-replica sample, so KEDA on queue
  depth wants sequential-port mode or a real metrics backend.
- **What changes if we ship it**: "What should I set for my box?" stops being a question —
  the box answers it, and a big Graviton instance finally delivers the throughput the
  benchmarks say it has.
