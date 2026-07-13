# Pocket Voice — a CPU-only, Arm-native cloud TTS service with voice cloning

> **Arm AI Optimization Challenge — Track 2: Cloud AI submission draft.**
> This document is the hackathon-facing description. Move it to the root
> `README.md` of your **own public repository** before submitting (see
> "Licensing & attribution" at the bottom).

## Project Overview

**Pocket Voice** turns Kyutai's [Pocket TTS](https://github.com/kyutai-labs/pocket-tts)
(a 100M-parameter, CPU-only text-to-speech model with zero-shot voice
cloning) into a **production-shaped, ElevenLabs-compatible HTTP service** that
runs entirely on **Arm CPUs** — no GPU, no cloud AI API, no per-character
billing.

**Why it's interesting / why it should win:**
- **The right workload for Arm Cloud.** TTS has historically meant GPUs or
  paid web APIs. Pocket TTS is small and CPU-native, so a fleet of cheap Arm
  cores (Graviton / Axion / Cobalt / Ampere) can serve it — the exact thesis
  of Track 2. We turn a research model into a deployable service on that
  substrate.
- **Voice cloning as a product feature, not a demo.** A 16-second reference
  clip produces a reusable 10 MB voice embedding; the API serves it like any
  built-in voice. Self-hosted cloning on commodity Arm CPUs undercuts hosted
  TTS by **100–1000×** on cost per hour of audio.
- **We measured the limits, we didn't guess them.** A bundled load-test
  harness ramps parallel requests and reports the degradation knee, throughput
  ceiling, and host CPU/RAM — and the data drove the architecture (scale by
  process/replica, not in-process worker, because the model is GIL-bound).
- **Drop-in compatibility.** The API mirrors ElevenLabs
  (`POST /v1/text-to-speech/{voice_id}`), so existing client code repoints with
  a base-URL change.

## Functionality / Output

The deliverable is a **runnable service** plus a **reproducible performance
study**:

1. **HTTP API** (`service/app.py`) — ElevenLabs-shaped:
   - `POST /v1/text-to-speech/{voice_id}` → audio bytes (`wav` / `mp3` / `pcm`),
     body `{text, model_id, voice_settings:{temperature}}`, optional
     `xi-api-key`. Timing headers (`X-Audio-Seconds`, `X-Synth-Seconds`,
     `X-Realtime-Factor`).
   - `GET /v1/voices`, `GET /health`, `GET /metrics`.
2. **Concurrency engine** (`service/engine.py`) — a bounded pool of independent
   model instances (generation is not thread-safe), an admission queue with
   **HTTP 429 backpressure** when full, and live metrics (in-flight, queue
   depth, latency p50/p95/p99, real-time factor).
3. **Voice cloning pipeline** (`clone_test.sh`) — audio → clean 24 kHz mono →
   `export-voice` → reusable `*.safetensors` → served by the API.
4. **Load-test harness** (`service/loadtest.py`) — ramps concurrency, reports
   latency percentiles / throughput / server RTF / CPU / RAM, and the
   recommended safe cap. Emits `loadtest_result.json`.

**Canonical audio cleanup.** Pocket TTS reproduces the *acoustic quality* of the
reference clip, so every clone path conditions audio through **one** shared
ffmpeg filter chain — `CLEANUP_FILTER` in `service/ingest.py`:
`highpass=f=80,afftdn=nf=-25,loudnorm` (drop sub-80 Hz rumble → spectral denoise
→ loudness-normalize) into 24 kHz mono. The ingest pipeline (sovereign local
isolation **and** cloud post-isolation), the direct `POST /v1/voices` upload
(`service.ingest.clean_audio`), and `clone_test.sh` all use this exact string, so
a voice sounds the same however it was cloned. Change it in one place. Commit
also enforces a **4 s minimum** per stem (`MIN_STEM_SECONDS`): shorter stems
clone poorly, so they are skipped and reported rather than turned into a bad Voice.

### Measured performance — three Arm variants (all bf16, CPU-index ARM torch)

| Platform | Single-stream RTF | In-process peak | 4-process scaling | Notes |
|---|---|---|---|---|
| Windows-ARM64 dev box | ~1.9× | ~2.2 aud/s | 4.14 aud/s | 12 threads, unoptimized reference |
| Graviton2 · `t4g.small` (Neoverse N1) | 1.33× | — | — | 2 vCPU, free-tier, burstable |
| **Graviton4 · `c8g.2xlarge` (Neoverse V2)** | **4.26×** | **~6.0 aud/s** | **~10.9 aud/s** | 8 vCPU, ~46% CPU at in-process ceiling |

**Graviton4 is ~2.3× faster single-stream than the dev box and ~3.2× the N1** — a
3-second sentence renders in ~0.7s. One `c8g.2xlarge` (~$0.29/hr) sustains
**~10.9 audio-seconds/second ≈ ~650 audio-minutes/hour ≈ ~98 two-sentence
requests/minute**, at **~$0.0004 per audio-minute** of compute (1000×+ under
hosted TTS).

**Two findings that generalise:**
1. **Scale by process/replica, not in-process workers.** On *every* box CPU tops
   out well before throughput (c8g: ~46% at its in-process ceiling) — the model
   is **GIL/serialization-bound**. Running N single-worker processes (separate
   GILs) ≈ doubles throughput vs one N-worker process. `WORKERS ≈ vCPU / THREADS`,
   pinned per replica.
2. **Install torch from the CPU index.** On aarch64, PyPI's default `torch` is a
   **CUDA (GH200) build** whose CPU fallback bypasses the oneDNN + Arm Compute
   Library path; the CPU-index wheel (`--index-url .../whl/cpu`) restores ACL and
   lifted single-stream ~8% on N1.

### Which instance to run

- **Demo site → free tier `t4g.small` by default.** A hosted demo runs for months
  with little/no real traffic, so t4g's burstable limit never bites — and it stays
  free-tier eligible. This is the default deployment target.
- **Production / benchmarking → `c8g` (Graviton4).** Non-burstable Neoverse V2 for
  real throughput. Needs a **paid** AWS account plan (see `aws/README.md`).

## Setup Instructions (Arm64 / Arm-powered device)

**Prerequisites:** an Arm64 Linux instance (AWS Graviton, GCP Axion, Azure
Cobalt, or Ampere), Docker, and ffmpeg. Python 3.10–3.14.

### Option A — Docker (recommended, Arm-optimized base)

```bash
# On the Arm64 host:
git clone https://github.com/xkazm04/gravitone.git
cd gravitone
docker build -f Dockerfile -t gravitone .
docker run --rm -p 8080:8080 \
  -e ONEDNN_DEFAULT_FPMATH_MODE=bf16 \
  -e TTS_WORKERS=1 -e TTS_TORCH_THREADS=4 \
  -v $PWD/voices:/app/voices \
  gravitone
```

### One-command benchmark (characterize the box)

```bash
git clone https://github.com/xkazm04/gravitone.git && cd gravitone
bash benchmark_arm.sh          # installs deps, warms the model, sweeps
                               # configs + process-scaling, prints a summary.
# Uses the built-in "alba" voice → no HuggingFace token needed.
```

### Option B — native venv

```bash
sudo apt-get update && sudo apt-get install -y python3-venv ffmpeg
python3 -m venv .venv && source .venv/bin/activate
pip install -U pip && pip install -r requirements.txt
ONEDNN_DEFAULT_FPMATH_MODE=bf16 TTS_WORKERS=1 TTS_TORCH_THREADS=4 \
  python -m service.app                          # → http://0.0.0.0:8080
```

### Option C — one-click cloud deploy ("Private ElevenLabs")

```bash
# One Graviton box, bootstrapped end-to-end, key-protected, ready in minutes:
deploy/aws-oneclick.sh up                  # or the CloudFormation template
# → Base URL + xi-api-key printed; ElevenLabs clients migrate with one env change.
```

See `deploy/README.md` — includes the CloudFormation template a cloud-
marketplace listing wraps, and a curl-pipe bootstrap for any Arm box.

### Validate

```bash
# 1. Health
curl -s localhost:8080/health

# 2. Synthesize with a built-in voice
curl -X POST "localhost:8080/v1/text-to-speech/alba?output_format=wav_24000" \
  -H "Content-Type: application/json" \
  -d '{"text":"Running text to speech on Arm, on CPU."}' --output out.wav

# 3. Clone a voice from a recording, then synthesize with it
bash clone_test.sh myvoice.mp3
curl -X POST "localhost:8080/v1/text-to-speech/myvoice" \
  -H "Content-Type: application/json" \
  -d '{"text":"This is my cloned voice."}' --output cloned.wav

# 4. Find this machine's concurrency cap (or just run: bash benchmark_arm.sh)
python -m service.loadtest \
  --voice alba --levels 1,2,3,4,6,8 --requests 8
```

### Scaling on Arm — the replica launcher

The model is **GIL/serialization-bound**, so the way to use all your cores is to
run **N single-worker processes**, not one N-worker process (the load-test and
certification harnesses both recommend exactly this). `service/replicas.py` is
the supervisor that runs that topology:

```bash
# Run 4 single-worker replicas on one box (deploy target: Arm Linux).
python -m service.replicas --replicas 4 --port 8000
```

What it does:
- **Spawns N uvicorn single-worker replicas** and pins each one's thread budget
  (`TTS_WORKERS=1`, plus `TTS_TORCH_THREADS` / `OMP_NUM_THREADS` /
  `OPENBLAS_NUM_THREADS` / `MKL_NUM_THREADS = max(1, cores // replicas)`) **before**
  each process starts, so the replicas don't oversubscribe the CPU.
- **Shares one client-facing port** via `SO_REUSEPORT` on **Arm Linux** — the
  kernel load-balances connections across replicas, so clients hit a single
  `:8000`. On non-Linux dev boxes that kernel feature isn't available, so it
  **falls back to sequential ports** `8000, 8001, … 8000+N-1` (logged at start-up).
- **Supervises** the replicas: restarts a dead one with bounded exponential
  backoff, fans `SIGTERM` out to all children on shutdown, and waits for them.
- **Aggregated metrics**: a stdlib HTTP endpoint on `--metrics-port` (default
  `--port + 1000`, e.g. `:9000`) fans `GET /metrics` out to every replica and
  returns `{"replicas": [...], "totals": {received, completed, rejected_429,
  errored, timeouts, abandoned, in_flight, queued}}`. Per-replica totals are
  exact in the sequential-port mode; under `SO_REUSEPORT` the replicas answer on
  one shared port and aren't individually addressable (documented trade-off —
  use `--no-reuse-port` if you need per-replica accuracy).

`python -m service.certify` prints the recommended replica count for your box
and the exact `service.replicas` command to run it.

### ElevenLabs compatibility matrix (drop-in switch kit)

Migrating an existing ElevenLabs integration is a **base-URL change** — same
paths, same auth header, same body shape. What maps where:

| ElevenLabs surface | Gravitone | Notes |
|---|---|---|
| `POST /v1/text-to-speech/{voice_id}` | ✅ same path | body `{text, model_id, voice_settings}` |
| `xi-api-key` header | ✅ same header | root key or a `/v1/keys`-issued scoped key; `Authorization: Bearer` also accepted |
| `output_format=` query param | ✅ `wav_24000`, `mp3_24000_128`, `pcm_24000` | |
| `voice_settings.stability` | ✅ mapped | → noise clamp |
| `voice_settings.similarity_boost`, `style` | ⚪ accepted, ignored | no equivalent knob in pocket-tts |
| `GET /v1/voices` | ✅ same path | readable with a tts-scoped key, like ElevenLabs |
| Voice cloning | ✅ `POST /v1/voices` (multipart) | 16 s sample → reusable voice |
| Emotion addressing | ✅➕ Gravitone extension | `/v1/text-to-speech/{character}:{emotion}` (or `?emotion=`), baseline fallback reported in `X-Emotion-*` headers |
| Multi-character scripts | ✅➕ `POST /v1/performance` | one call, many Characters, inline `[emotion]` metatags; needs the `performance` key scope |
| Character capability manifest | ✅➕ `GET /v1/characters/{id}/manifest` | which emotions a Character performs natively vs falls back |
| Streaming endpoint (`/stream`) | ❌ not yet | whole-utterance responses; ~realtime on Arm |
| Usage accounting | ✅ `X-Audio-Seconds` header + `audio_seconds_total` in `/metrics` | feeds the studio's "you'd have paid $X at ElevenLabs" ticker |

### Characters, not voices — the emotion-addressable API

A **Character** groups cloned Voices of one speaker across the emotion scale
(baseline, calm, happy, excited, sad, angry, whisper, confused). Three ways to
direct one:

```bash
# 1. Emotion addressing on the compatible endpoint — voice_id is character:emotion
curl -X POST "localhost:8080/v1/text-to-speech/sarah:excited" \
  -H "xi-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"text":"One character, many moods."}' --output line.wav
# Missing emotions fall back to baseline — see X-Emotion-Used / X-Emotion-Fallback.

# 2. Inline metatags: emotions switch mid-script (X-Segments has the report)
curl -X POST "localhost:8080/v1/speak" \
  -H "xi-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"character_id":"sarah","text":"Hello. [excited]This is amazing![/excited] Back to calm."}' \
  --output scene.wav

# 3. Character Performance API: a multi-character script in one call
#    (premium — requires a key with the "performance" scope)
curl -X POST "localhost:8080/v1/performance" \
  -H "xi-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"lines":[
        {"character_id":"sarah","text":"[excited]We open at dawn."},
        {"character_id":"alba","text":"And the narrator sets the scene."}]}' \
  --output act1.wav
# Per-line/segment substitution report: X-Performance-Report (base64 JSON).

# Check what a Character can perform before directing it:
curl -s -H "xi-api-key: $KEY" localhost:8080/v1/characters/sarah/manifest
```

## The full studio — two products, one repo

Gravitone is **two products** that together form the studio, living side by
side in this monorepo:

```
gravitone/
├── service/   ← the TTS backend (Python / FastAPI, runs on Arm CPU)
├── deploy/    ← one-click cloud deploy + Helm fleet chart
└── web/       ← the studio UI (Next.js 15)

┌──────────────────────┐   GRAVITONE_URL    ┌───────────────────────────┐
│  web/ (studio)       │ ─────────────────▶ │  service/ (TTS backend)   │
│  Next.js studio UI   │   /v1/* over HTTP  │  python -m service.app    │
│  (auth, playground,  │                    │  :8080  · runs on Arm CPU │
│   voices, keys,      │                    │  pocket-tts clone + serve │
│   ingestion)         │                    └───────────────────────────┘
└──────────────────────┘
```

**Product 1 — TTS backend (`service/`).** Run it per *Setup Instructions* above.
For the **ingestion** feature (build a Character from a recording) the backend
also needs, in its env:

```bash
ELEVEN_LABS_API_KEY=…   # Scribe diarization + Voice Isolator
GEMINI_API_KEY=…        # emotion classification (gemini-3.5-flash → 3.1-pro escalate)
HF_TOKEN=…              # first-run only: gated pocket-tts voice-cloning weights
```

**Product 2 — web studio (`web/`).** Next.js 15 app (playground, voice &
Character management, API keys, Firebase Google-auth + Firestore profiles, and the
recording-ingestion flow). It talks to the backend via **`GRAVITONE_URL`**:

```bash
# web/.env.local
GRAVITONE_URL=http://127.0.0.1:8080          # or https://tts.<your-domain> in prod
NEXT_PUBLIC_FIREBASE_API_KEY=…               # web config (public by design)
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=…
NEXT_PUBLIC_FIREBASE_PROJECT_ID=…
# … (see web/.env.example for the full set)

npm install && npm run dev                    # → http://localhost:3001
```

**Local dev:** start the backend on `:8080`, then the web app on `:3001` with
`GRAVITONE_URL` pointing at it. **Deploy:** put the backend on an Arm instance
(**`t4g.small` free-tier for the demo**, `c8g` for production) and host the web app
(e.g. Vercel) with `GRAVITONE_URL` set to the instance's URL. The web app is
stateless per request, so it can also sit behind the same box.

### Arm optimizations applied (Track 2 relevance)

| Lever | How | Effect |
|---|---|---|
| **CPU-index torch** | `pip install torch --index-url https://download.pytorch.org/whl/cpu` | avoids PyPI's aarch64 CUDA (GH200) wheel whose CPU fallback bypasses ACL; **+8%** single-stream on N1 |
| **oneDNN + Arm Compute Library** | default in the CPU-index aarch64 wheel / `armswdev/pytorch-arm-neoverse` | ACL GEMM kernels for fp32/bf16 |
| **BF16 fast-math** | `ONEDNN_DEFAULT_FPMATH_MODE=bf16` | fp32 matmuls dispatched to BF16 kernels on Neoverse (BF16/I8MM HW) |
| **KleidiAI** | Kleidi-enabled aarch64 PyTorch wheel | automatic inference uplift, no code change |
| **int8 quantization** | `TTS_QUANTIZE=true` | ~27% faster / ~48% less memory (validate quality on Arm qengine) |
| **Process-level scaling** | N single-worker replicas, `WORKERS≈vCPU/THREADS` | bypasses the GIL ceiling to use all cores |

## Architecture

```
client → FastAPI (ElevenLabs API)
           │  admission semaphore (workers + queue_max) ── full? → 429 Retry-After
           ▼
        job queue → [worker 0..N]  each: own TTSModel + voice-state cache
           ▼
        24 kHz WAV / MP3 / PCM  (+ timing headers)
```
Stateless per request → front N replicas with a load balancer (and SQS /
Pub-Sub for cross-replica fairness). Scale horizontally; the 429 signal drives
autoscaling.

## Licensing & attribution

- This project builds on **Kyutai Pocket TTS** (MIT). Keep an **MIT** (or
  Apache-2.0) `LICENSE` at your repo root so it's detectable in the GitHub
  **About** section, as Track 2 requires.
- Recommended: create a **new public repo** containing `service/`, `Dockerfile`,
  `clone_test.sh`, and this file as `README.md`; depend on `pocket-tts` via
  `pip` (don't vendor it). Add an MIT `LICENSE` with **your** copyright and an
  attribution line: *"Built on Kyutai Pocket TTS (MIT), https://github.com/kyutai-labs/pocket-tts."*
- Voice assets have **per-voice licenses** (see
  https://huggingface.co/kyutai/tts-voices) — only ship voices you have the
  right to, and only clone voices with the speaker's consent (see Pocket TTS
  "Prohibited use").
