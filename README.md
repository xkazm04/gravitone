# Gravitone

**A CPU-only, Arm-native cloud TTS service with voice cloning — an
ElevenLabs-compatible API that runs on commodity Arm cores, no GPU, no
per-character billing.**

> **Arm AI Optimization Challenge — Track 2: Cloud AI.**
> Built on Kyutai [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) (MIT).
> Licensed MIT — see [`LICENSE`](LICENSE).

---

## Where everything lives

The app lives in **[`gravitone/`](gravitone/)**. This file is the front door;
the full setup, API surface and measurements are in the project README.

| Document | What it covers |
|---|---|
| **[`gravitone/README.md`](gravitone/README.md)** | **Start here.** Full setup (Docker / venv / one-click cloud), the complete API surface, the ElevenLabs compatibility matrix, benchmarks and limits. |
| [`gravitone/docs/SWITCH_FROM_ELEVENLABS.md`](gravitone/docs/SWITCH_FROM_ELEVENLABS.md) | Step-by-step migration of an existing ElevenLabs integration. |
| [`gravitone/docs/SUPPORTED_HARDWARE.md`](gravitone/docs/SUPPORTED_HARDWARE.md) | Certified hardware matrix — measured RTF and capacity per box. |
| [`gravitone/docs/DETERMINISM.md`](gravitone/docs/DETERMINISM.md) | What repeats and what does not, asserted by tests. |
| [`gravitone/deploy/README.md`](gravitone/deploy/README.md) | One-click AWS deploy, CloudFormation template, Helm fleet chart. |

```
gravitone/
├── service/   ← the TTS backend (Python / FastAPI, runs on Arm CPU)
├── deploy/    ← one-click cloud deploy + Helm fleet chart
├── docs/      ← hardware matrix, migration guide, determinism contract
└── web/       ← the studio UI (Next.js 15)
```

## What it is

Gravitone turns Pocket TTS — a 100M-parameter, CPU-only text-to-speech model
with zero-shot voice cloning — into a **production-shaped, ElevenLabs-compatible
HTTP service** that runs entirely on **Arm CPUs**.

- **HTTP API** — `POST /v1/text-to-speech/{voice_id}` with the same paths, the
  same `xi-api-key` header and the same body shape as ElevenLabs, so existing
  client code repoints with a base-URL change. Plus `/v1/voices`, `/health`,
  `/metrics`, streaming, and timing headers on every synthesis.
- **Voice cloning as a product feature.** A 16-second reference clip becomes a
  reusable voice embedding the API serves like any built-in voice — with a
  **consent receipt** stored verbatim alongside it on every clone path.
- **Characters, not just voices.** A Character groups cloned voices of one
  speaker across an emotion scale, addressable as `voice_id = character:emotion`,
  with inline `[emotion]` metatags and a multi-character performance endpoint.
- **A concurrency engine that tells the truth.** A bounded pool of independent
  model instances, an admission queue with **HTTP 429 backpressure**, and live
  latency / throughput / real-time-factor metrics.
- **Local speech-to-text and conversational agents.** The ElevenLabs Agents
  WebSocket served locally — a full spoken conversation at **$0.00 per minute**,
  with no audio leaving the machine.

## Why it fits Track 2

**TTS has historically meant GPUs or paid web APIs.** Pocket TTS is small and
CPU-native, so a fleet of cheap Arm cores (Graviton / Axion / Cobalt / Ampere)
can serve it — the exact thesis of Track 2. This project takes a research model
and makes it deployable on that substrate, then measures what the substrate
actually does.

### Measured performance — three Arm variants (all bf16, CPU-index Arm torch)

| Platform | Single-stream RTF | In-process peak | 4-process scaling | Notes |
|---|---|---|---|---|
| Windows-ARM64 dev box | ~1.9× | ~2.2 aud/s | 4.14 aud/s | 12 threads, unoptimized reference |
| Graviton2 · `t4g.small` (Neoverse N1) | 1.33× | — | — | 2 vCPU, free-tier, burstable |
| **Graviton4 · `c8g.2xlarge` (Neoverse V2)** | **4.26×** | **~6.0 aud/s** | **~10.9 aud/s** | 8 vCPU, ~46% CPU at in-process ceiling |

Graviton4 is **~2.2× faster single-stream than the dev box (4.26 ÷ 1.9) and
~3.2× the N1 (4.26 ÷ 1.33)** — a 3-second sentence renders in ~0.7 s. One
`c8g.2xlarge` sustains **~10.9 audio-seconds/second ≈ ~650 audio-minutes/hour**,
which at its **$0.2903/hr** on-demand list price works out to **~$0.00044 per
audio-minute** (~$0.027 per audio-hour) of compute. Both inputs to that figure
are stated so the arithmetic can be checked; the per-tier comparison against
hosted TTS list prices is in the [project README](gravitone/README.md).

Every row is reproducible: `bash gravitone/benchmark_arm.sh` characterizes the
box and `python -m service.certify` emits a certificate. The three rows above
were **measured, not certified-into-the-ledger** —
`gravitone/docs/certifications/ledger.json` is deliberately empty until a run
goes through `--append-ledger`, and the
[hardware matrix](gravitone/docs/SUPPORTED_HARDWARE.md) says so on its face.

### Arm optimizations applied

| Lever | How | Effect |
|---|---|---|
| **CPU-index torch** | `pip install torch --index-url https://download.pytorch.org/whl/cpu` | avoids PyPI's aarch64 CUDA (GH200) wheel whose CPU fallback bypasses ACL; **~8%** single-stream on `t4g.small` — one unlogged observation, not a certified row |
| **oneDNN + Arm Compute Library** | default in the CPU-index aarch64 wheel / `armswdev/pytorch-arm-neoverse` | ACL GEMM kernels for fp32/bf16 |
| **BF16 fast-math** | `ONEDNN_DEFAULT_FPMATH_MODE=bf16` | fp32 matmuls dispatched to BF16 kernels on Neoverse (BF16/I8MM hardware) |
| **KleidiAI** | Kleidi-enabled aarch64 PyTorch wheel | automatic inference uplift, no code change |
| **Process-level scaling** | N single-worker replicas, `WORKERS ≈ vCPU / THREADS` | bypasses the GIL ceiling to use all cores |
| **int8 quantization** | `TTS_QUANTIZE=true` — **off by default** | stays off until an A/B row on *your* hardware shows a win; the figure this repo once quoted was x86 (fbgemm) and does not transfer to aarch64 |

Each lever is individually revertible from the environment, and
`bash gravitone/benchmark_arm_ab.sh` A/Bs them one at a time so the number you
believe is the one your own box produced.

### Two findings that generalise

1. **Scale by process/replica, not in-process workers.** On *every* box the CPU
   tops out well before throughput (c8g: ~46% at its in-process ceiling) — the
   model is **GIL/serialization-bound**. Running N single-worker processes
   (separate GILs) roughly doubles throughput versus one N-worker process.
2. **Install torch from the CPU index.** On aarch64, PyPI's default `torch` is a
   CUDA (GH200) build whose CPU fallback bypasses the oneDNN + Arm Compute
   Library path. The CPU-index wheel restores ACL; on `t4g.small` we saw ~8%
   single-stream from it — a one-off observation with no A/B artifact checked
   in, so the mechanism is the finding and the percentage is directional.

## Architecture

```
client → FastAPI (ElevenLabs-shaped API)
           │  admission semaphore (workers + queue_max) ── full? → 429 Retry-After
           ▼
        job queue → [worker 0..N]   each: own TTSModel + voice-state cache
           ▼
        24 kHz WAV / MP3 / PCM  (+ timing headers)

┌──────────────────────┐   GRAVITONE_URL    ┌───────────────────────────┐
│  web/ (studio)       │ ─────────────────▶ │  service/ (TTS backend)   │
│  Next.js studio UI   │   /v1/* over HTTP  │  python -m service.app    │
│  playground, voices, │                    │  :8080 · runs on Arm CPU  │
│  keys, ingestion     │                    │  pocket-tts clone + serve │
└──────────────────────┘                    └───────────────────────────┘
```

Stateless per request, so N replicas sit behind a load balancer and the 429
signal drives autoscaling. `service/replicas.py` runs that topology on one box —
N single-worker uvicorn processes sharing a port via `SO_REUSEPORT` on Arm
Linux, each with a pinned thread budget.

## Quick start

```bash
git clone https://github.com/xkazm04/gravitone.git
cd gravitone/gravitone          # repo root is the arm/ workspace; the app lives here

docker build -f Dockerfile -t gravitone .
docker run --rm -p 8080:8080 \
  -e ONEDNN_DEFAULT_FPMATH_MODE=bf16 \
  -e TTS_WORKERS=1 -e TTS_TORCH_THREADS=4 \
  -v $PWD/voices:/app/voices \
  gravitone

curl -X POST "localhost:8080/v1/text-to-speech/alba?output_format=wav_24000" \
  -H "Content-Type: application/json" \
  -d '{"text":"Running text to speech on Arm, on CPU."}' --output out.wav
```

Native venv, one-click cloud deploy, voice cloning, the load-test harness and
the web studio are all in **[`gravitone/README.md`](gravitone/README.md)**.

## Licensing & attribution

MIT — see [`LICENSE`](LICENSE). Built on **Kyutai Pocket TTS** (MIT),
<https://github.com/kyutai-labs/pocket-tts>.

Voice assets carry **per-voice licenses** (see
<https://huggingface.co/kyutai/tts-voices>) — only ship voices you have the
right to, and only clone voices with the speaker's consent.
