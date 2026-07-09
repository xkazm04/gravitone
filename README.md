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

**Measured output (dev box: Windows-on-Arm64, 12 threads, unoptimized).**
In-process throughput ceiling **≈ 2.2 audio-seconds per wall-second**; best
single request **2.0× real-time**. CPU peaks at only ~70% at that ceiling → the
model is **GIL/serialization-bound, not core-bound**. We proved the fix: **4
independent single-worker processes reached 4.14 aud/s — 1.88× the in-process
ceiling — on the same box**, lifting CPU to ~75%. So throughput scales by
running **independent processes/replicas** (separate GILs), not more in-process
workers. These are a **floor**: a Linux Neoverse instance with BF16 + KleidiAI
is expected to be materially faster (see optimizations below).

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

### Arm optimizations applied (Track 2 relevance)

| Lever | How | Effect |
|---|---|---|
| **oneDNN + Arm Compute Library** | default in aarch64 PyTorch / `armswdev/pytorch-arm-neoverse` | ACL GEMM kernels for fp32/bf16 |
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
