# Gravitone — a CPU-only, Arm-native cloud TTS service with voice cloning

> **Arm AI Optimization Challenge — Track 2: Cloud AI.**
> Built on Kyutai [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) (MIT)
> — see "Licensing & attribution" at the bottom.

## Project Overview

**Gravitone** turns Kyutai's [Pocket TTS](https://github.com/kyutai-labs/pocket-tts)
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
  TTS by **100–1000×** on cost per hour of audio — the arithmetic, with both of
  its inputs (instance list price, measured throughput), is under "Measured
  performance" below.
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
5. **Local speech-to-text** (`service/stt.py`) — `POST /v1/speech-to-text`,
   shaped like ElevenLabs Scribe, backed by faster-whisper (CTranslate2 int8 on
   CPU). Per-request keyword bias, which the hosted browser SDK cannot do at
   all. Optional **speaker diarization** (`service/diarize.py`, sherpa-onnx —
   chosen over pyannote.audio because its pretrained pipelines need a
   HuggingFace account, which a service that claims to run offline cannot
   demand).
6. **Conversational agents** (`service/convai.py`) — the **ElevenLabs Agents
   WebSocket, served locally**: `GET /v1/convai/conversation/get-signed-url`
   then a duplex socket that hears the caller (`service/vad.py` finds the turn
   boundaries, `stt.py` transcribes), answers (`service/dialog.py`), and speaks
   through the same worker pool. Barge-in, ping/pong and per-session prompt
   overrides included. An app already written against ElevenLabs Agents
   repoints by changing **one base URL** — the browser SDK needs no changes.

**A conversation costs nothing per minute.** Hosted conversational AI bills by
the minute (published rates were around $0.10/min when this was written; unlike
the TTS list prices in `web/lib/switchkit.ts`, this repo carries **no dated
receipt** for that figure — treat it as an order-of-magnitude estimate, and the
$0.00 side as the only number here we measured), which is what makes
*automated* spoken testing — run the same interview a hundred times, measure
word error rate and turn latency — a line item instead of a habit. The whole
loop here is local: 3-second turn latency budget on this class of hardware,
$0.00 per minute, and no audio leaves the machine.

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

Source for every row: [`docs/SUPPORTED_HARDWARE.md`](docs/SUPPORTED_HARDWARE.md),
measured 2026-07 with `benchmark_arm.sh` → `service/loadtest.py`. The same three
rows drive the web dataset (`web/lib/benchmarks.ts`).

**Graviton4 is ~2.2× faster single-stream than the dev box (4.26 ÷ 1.9) and ~3.2×
the N1 (4.26 ÷ 1.33)** — a 3-second sentence renders in ~0.7 s. One
`c8g.2xlarge` sustains **~10.9 audio-seconds/second ≈ ~650 audio-minutes/hour**
(10.9 × 3600 ÷ 60), which at a **$0.2903/hr** on-demand list price (us-east-1,
the figure in `web/lib/benchmarks.ts`) is **~$0.00044 per audio-minute** of
compute — about **$0.027 per audio-hour**. At ~6.7 s of audio per two-sentence
request that is ~98 requests/minute.

Against ElevenLabs list pricing as captured in `web/lib/switchkit.ts`
(`asOf` 2026-07-10, $7.20–$13.20 per audio-hour depending on tier), the same
audio costs **~270–500× less on `c8g.2xlarge`** and **~600–1000× less on the
free-tier-eligible `t4g.small`** ($0.0168/hr ÷ 1.33× ≈ $0.013 per audio-hour) —
which is where the "100–1000×" headline above comes from. Both inputs to every
figure (instance list price, measured throughput) are named so the arithmetic
can be checked.

**Two findings that generalise:**
1. **Scale by process/replica, not in-process workers.** On *every* box CPU tops
   out well before throughput (c8g: ~46% at its in-process ceiling) — the model
   is **GIL/serialization-bound**. Running N single-worker processes (separate
   GILs) ≈ doubles throughput vs one N-worker process. `WORKERS ≈ vCPU / THREADS`,
   pinned per replica.
2. **Install torch from the CPU index.** On aarch64, PyPI's default `torch` is a
   **CUDA (GH200) build** whose CPU fallback bypasses the oneDNN + Arm Compute
   Library path; the CPU-index wheel (`--index-url .../whl/cpu`) restores ACL.
   The uplift we saw was **~8% single-stream on `t4g.small`** — a one-off
   observation from the July 2026 run, *not* a certified row: no A/B artifact
   for it is checked in, so treat it as directional and re-measure with
   `benchmark_arm_ab.sh` on your own box. The mechanism (CUDA wheel → no ACL) is
   the durable finding; the percentage is not.

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
cd gravitone/gravitone   # repo root is the arm/ workspace; the app lives here
docker build -f Dockerfile -t gravitone .
docker run --rm -p 8080:8080 \
  -e ONEDNN_DEFAULT_FPMATH_MODE=bf16 \
  -e TTS_WORKERS=1 -e TTS_TORCH_THREADS=4 \
  -v $PWD/voices:/app/voices \
  gravitone
```

### One-command benchmark (characterize the box)

```bash
git clone https://github.com/xkazm04/gravitone.git && cd gravitone/gravitone
bash benchmark_arm.sh          # installs deps, warms the model, sweeps
                               # configs + process-scaling, prints a summary.
# Uses the built-in "alba" voice → no HuggingFace token needed.

bash benchmark_arm_ab.sh       # A/B each Arm inference setting on its own
                               # (inference_mode, flush-denormal, interop
                               # threads, oneDNN bf16 fast-math, int8 +
                               # qnnpack, ffmpeg thread cap) and print the
                               # realtime factor each one bought ON THIS BOX.
```

All of those settings are individually revertible from the environment
(`TTS_INFERENCE_MODE`, `TTS_FLUSH_DENORMAL`, `TTS_TORCH_INTEROP_THREADS`,
`TTS_FFMPEG_THREADS`, `ONEDNN_DEFAULT_FPMATH_MODE`, `TTS_QUANTIZE` /
`TTS_QUANTIZED_ENGINE`) and all are applied by default **except int8
quantization**, which stays off until an A/B row on your own hardware shows a
win — the "~27% faster" figure this repo used to quote was measured on x86
(fbgemm) and does not transfer to aarch64, where int8 comes from a different
backend than the fp32 path. See `service/config.py` for each default and why.
The repo quotes no speedup figures: run the A/B on your hardware and use its
numbers.

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

# 4. Transcribe a recording (first call downloads the model, ~460 MB)
curl -X POST localhost:8080/v1/speech-to-text \
  -F file=@out.wav -F keywords="Arm Graviton"

# 5. List the conversational agents and mint a conversation URL
curl -s localhost:8080/v1/convai/agents
curl -s "localhost:8080/v1/convai/conversation/get-signed-url?agent_id=local-interviewer"

# 6. Find this machine's concurrency cap (or just run: bash benchmark_arm.sh)
python -m service.loadtest \
  --voice alba --levels 1,2,3,4,6,8 --requests 8
```

### Holding a conversation

The socket in step 5 speaks the ElevenLabs Agents protocol: send
`conversation_initiation_client_data`, then a continuous stream of
`{"user_audio_chunk": "<base64 PCM16 mono 16 kHz>"}` paced in real time, and
read back `user_transcript`, `agent_response`, `audio` and `interruption`.

Who answers is `CONVAI_LLM`, and the choice is a latency-for-realism trade with
measured numbers:

| `CONVAI_LLM` | Turn latency | What it is |
|---|---|---|
| **`scripted`** (default) | **1.3–1.7 s** | Fixed turns, no model, nothing to install. Deterministic — which is what a word-error-rate or latency assertion needs. |
| `claude-cli` | **11–15 s** | The `claude` CLI headless on the machine's own subscription. Real adaptive conversation, no API key, no server, no download. |
| `openai-compat` | depends | Any local OpenAI-compatible server (LM Studio, llama.cpp, vLLM). |

`scripted` is not a placeholder — a test that asserts WER or turn latency needs
the interviewer to say the same thing every run. Reach for `claude-cli` when the
test is about behaviour: it answers what the candidate actually said ("That's
solid experience with Python and PostgreSQL — what's been your most recent
role?"), at roughly ten times the turn cost. Most of that is the CLI's own
start-up and thinking, and it gets worse under load because it competes with
synthesis for the same cores.

`GET /v1/convai/agents` reports which brain is live, because a scripted agent
and a model-driven one sound identical from the outside.

**The CLI brain runs disarmed.** A default `claude -p` session has Bash, Write
and a scheduler available, which should not be one hallucination away from an
unattended interview. `--disallowed-tools` removes them (verified — unlike
`--allowed-tools`, which only decides what is *pre-approved* and leaves
everything callable), `--system-prompt` replaces Claude Code's identity with the
agent's brief, and if a tool call appears anyway the turn is killed and fails
loudly. The denylist lowers the odds; the abort is the guarantee, because it
does not depend on knowing the tool's name.

An agent is a JSON file in `agents/` — prompt, voice, language, opening line,
keyword bias, and an optional script. A file whose id matches a built-in
replaces it, which is how you re-voice or re-prompt the shipped interviewer
without forking the source.

### Speaking a language Pocket TTS doesn't

Pocket TTS speaks English and French. The transcriber understands dozens, so a
Czech caller was *heard* correctly and answered in English phonetics — a
conversation that worked and was unusable. `service/piper.py` is a **second**
synthesis engine (Piper, ONNX, CPU, MIT) for exactly that gap, and it is a
fallback rather than a replacement: Pocket TTS keeps voice cloning and emotion
voices, which Piper has no answer to.

```bash
python -m piper.download_voices --download-dir piper_voices cs_CZ-jirka-medium
curl -s "localhost:8080/v1/convai/conversation/get-signed-url?agent_id=local-interviewer-cs"
```

The shipped `local-interviewer-cs` agent names **no voice** — `"language": "cs"`
is enough, because a language Pocket TTS cannot speak resolves to a Piper voice
automatically. With no Czech voice installed that agent reports itself
`"speakable": false` with the download command, instead of reading Czech words
with English phonemes. A full Czech conversation measured **1.2 s** per turn.

Keyword bias is what makes technical speech survive. Czech Whisper heard
"backendové služby v Pythonu a PostgreSQL" as *"bekendové služby v Pithanu a
pozdějc Esquale"*; with the agent's `keywords` list it became *"backendové
služby v Pythonu a pozdějc SQL"* — two of the three terms recovered. "PostgreSQL"
in Czech speech remains stubborn, and that is the honest state of it.

### Who spoke when

```bash
python -m service.diarize --download        # ~34 MB, no account needed
curl -X POST localhost:8080/v1/speech-to-text \
  -F file=@interview.wav -F diarize=true
```

Words come back tagged `speaker_0` / `speaker_1` (renumbered in order of first
appearance — the clusterer's own ids are arbitrary and sparse), plus the speaker
turns and a `speaker_count_is_a_hypothesis` flag that is always true. Read the
limits above before believing a count.

### Recordings — playing a test back

`CONVAI_RECORD=1` makes every conversation leave `recordings/<id>/`:

```
user.wav          what the caller's microphone sent
agent.wav         what the agent said back
transcript.json   every turn, with audio_s / transcribe_s / answer_s per turn
meta.json         agent, voice, brain, transcriber, how it ended
```

**The two WAVs share one timeline** — open them on two tracks and you are
listening to the call as it happened. That takes work rather than luck: the
agent's audio is transmitted much faster than it plays, so its track is padded
to the moment the caller actually heard each reply begin. `transcript.json`
carries the numbers a word-error-rate or latency report is computed from, and
`GET /v1/convai/conversations` lists what has been recorded.

Recording is **off by default**. This service's claim is that audio does not
leave the machine; writing every caller's voice to disk unasked is a different
promise, and it belongs to an operator rather than to a default. For test runs,
where the recording is the deliverable, turn it on.

### Pointing an existing app at it

An app already written against ElevenLabs Agents needs one environment change.
Verified against [kp](https://github.com/xkazm04/kp)'s AI interviewer, whose
browser client is `@elevenlabs/react` and which needed **no client change at
all** — the SDK connects to whatever signed URL the server hands it:

```bash
ELEVENLABS_BASE_URL=http://127.0.0.1:8080   # instead of api.elevenlabs.io
ELEVENLABS_AGENT_ID=local-interviewer
ELEVENLABS_API_KEY=local                    # a local service may ignore it
```

Its own spoken-interview harness then ran 11 scenarios (including barge-in,
monologue, hostile and prompt-injection probes) end to end against this
service — every session completing, no turns dropped, **corpus WER 0–12%** and
**p95 turn latency 1.2–1.8 s**, at zero cost per minute.

### Limits worth knowing before you rely on it

- **Diarization is good on people, bad on robots.** Measured against
  sherpa-onnx's labelled human fixtures it got both exactly right (2→2, 4→4 at
  the default threshold). Pointed at this service's own synthesized voices it
  reported two speakers as three — independently generated TTS moves the speaker
  embedding more than one real person's voice does. There is deliberately **no
  "number of speakers" parameter**: the underlying `num_clusters` does not
  honour it (asking for 4 gave 3, asking for 2 gave 1), so `speaker_threshold`
  is the only honest knob and counts skew high. Treat the count as a hypothesis
  a human may correct.
- **The scripted brain cannot adapt.** It says the same lines every run, which
  is exactly why latency and word-error tests use it — and means it will not
  follow a speaker into another language or answer a question they asked. Use
  `CONVAI_LLM=claude-cli` when the test is about behaviour.
- **A level-based turn detector hears doors.** `service/vad.py` finds speech by
  loudness, not by phonetics, and the transcriber is the backstop: a false onset
  produces no words and is dropped rather than becoming an empty turn. A gate
  that opens mid-utterance also costs one utterance while it calibrates.

**Measured on the x86-64 dev box** (1 worker, `small` transcriber, scripted
brain) as a closed loop: the service synthesizes a candidate's line, streams it
back into its own ear at real-time pace, and answers.

| Server-side, end of speech → first audio | |
|---|---|
| Turn latency, steady state | **1.6 s** |
| Of which: transcribing ~4.6 s of speech | 1.3–1.6 s (~3x realtime) |
| Of which: synthesizing the first sentence | ~0.3 s |
| First turn of a conversation | 2.0 s |

Transcription dominates, so `STT_MODEL=base` is the dial to turn if 1.6 s is
too slow and the vocabulary is ordinary. The first turn is slightly dearer
because the transcriber loads while the agent speaks its opening line; without
that overlap it costs ~1.8 s more, which is why the session starts the load at
connect rather than at the first thing it hears. Replies are synthesized
sentence by sentence as the model writes them, so a **long** reply costs no
more before its first word is heard — a language-model brain adds only its own
time-to-first-sentence.

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
- **Pool metrics**: a stdlib HTTP endpoint on `--metrics-port` (default
  `--port + 1000`, e.g. `:9000`) that says what it is measuring via `scope`:
  - sequential-port mode → `scope: "pool_total"`, with real `totals`
    (`received, completed, rejected_429, errored, timeouts, abandoned,
    in_flight, queued, audio_seconds_total`) plus `replicas_reporting` /
    `replicas_expected` so a partial scrape is visible.
  - `SO_REUSEPORT` mode → `scope: "single_replica_sample"`, `totals: null`, and
    a `sample` from ONE arbitrary replica. The replicas share a port, so no
    scrape can address them individually and no honest pool total exists;
    the endpoint publishes the sample and says so rather than summing N random
    samples of one member. Use `--no-reuse-port` (trading away kernel
    load-balancing) when you need real per-replica totals.

`python -m service.certify` prints the recommended replica count for your box
and the exact `service.replicas` command to run it.

### ElevenLabs compatibility matrix (drop-in switch kit)

Migrating an existing ElevenLabs integration is a **base-URL change** — same
paths, same auth header, same body shape. **Step-by-step guide:
[docs/SWITCH_FROM_ELEVENLABS.md](docs/SWITCH_FROM_ELEVENLABS.md).** What maps where:

| ElevenLabs surface | Gravitone | Notes |
|---|---|---|
| `POST /v1/text-to-speech/{voice_id}` | ✅ same path | body `{text, model_id, voice_settings}` |
| `xi-api-key` header | ✅ same header | root key or a `/v1/keys`-issued scoped key; `Authorization: Bearer` also accepted |
| `output_format=` query param | ✅ `wav_24000`, `mp3_44100_128`, `pcm_16000`, … | full grammar in the guide; an unsupported one is a **400** listing what is supported, never a silent substitution |
| `voice_settings.stability` | ✅ mapped | → noise clamp |
| `voice_settings.similarity_boost`, `style`, `use_speaker_boost`, `speed` | ⚪ accepted, ignored | no equivalent knob in pocket-tts; **named on `X-Ignored-Settings`** |
| `seed`, `language_code`, `previous_text`/`next_text`, `previous_request_ids`/`next_request_ids`, `pronunciation_dictionary_locators`, `apply_text_normalization`, `apply_language_text_normalization`, `use_pvc_as_ivc` | ⚪ accepted, ignored | typed and declared, so a stock SDK body is **never a 422**; each one sent is named on `X-Ignored-Settings` |
| `GET /v1/voices` | ✅ same path | `{"voices": […]}` with `voice_id`, `name`, `category`, `labels`; readable with a tts-scoped key, like ElevenLabs |
| Voice cloning | ✅ `POST /v1/voices` (multipart) | 16 s sample → reusable voice |
| Emotion addressing | ✅➕ Gravitone extension | `/v1/text-to-speech/{character}:{emotion}` (or `?emotion=`), baseline fallback reported in `X-Emotion-*` headers |
| Multi-character scripts | ✅➕ `POST /v1/performance` | one call, many Characters, inline `[emotion]` metatags; needs the `performance` key scope |
| Character capability manifest | ✅➕ `GET /v1/characters/{id}/manifest` | which emotions a Character performs natively vs falls back |
| Streaming endpoint (`/stream`) | ✅ `POST /v1/text-to-speech/{voice_id}/stream` | sentence-chunked: first sentence streams while the rest renders. `pcm_*`/`wav_*` stream progressively; `mp3_*` (the EL SDK's default) returns the complete clip in **one body**, labelled `X-Stream: full-body` + `X-Stream-Fallback` — mp3 has no incremental transcode. No per-synthesis timing headers on the genuinely-streaming formats |
| `/stream/with-timestamps` | ✅ alias of `/with-timestamps` | one full payload, not a frame sequence (the alignment is computed by listening to the finished clip); needs a local transcriber or it **501**s by name |
| `GET /v1/user`, `GET /v1/user/subscription` | ❌ **not implemented** | deliberate: there is no credit meter to read. Quota-checking code is the one thing you delete on the way over |
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

### What repeats, and what doesn't — the determinism contract

Emotion here is a **recording you auditioned**, not a knob you nudged, so the
things that repeat are worth stating precisely — and so are the things that
don't. Full document: [`docs/DETERMINISM.md`](docs/DETERMINISM.md), asserted by
`service/tests/test_determinism.py`.

- **Emotion selection is arithmetic, not a suggestion.** `sarah:angry` resolves
  to the same embedding every time; the fallback walk is a pure function of the
  Character's slots, independent of registry ordering.
- **The sampling knobs are a fixed function of your request.** Nothing between
  the HTTP body and the model adds jitter, and inert compatibility settings are
  reported via `X-Ignored-Settings` rather than secretly mapped onto something.
- **An identical request is replayed, not re-rolled** — byte-for-byte, while the
  render is held (`X-Cache: hit`; per process, byte-budgeted, not persisted,
  and skippable with `Cache-Control: no-store`).
- **A cold re-render is NOT byte-identical, and we don't pretend it is.** Pocket
  TTS samples at `temp` and nothing on this path seeds an RNG. There is no
  `seed` parameter, deliberately — `docs/DETERMINISM.md` explains why a
  three-line one was rejected rather than shipped.

### Consent receipts — every clone is on the record

Cloning is gated on an ownership attestation, and the **exact** statement the
user agreed to is stored *verbatim* with the voice as a **consent receipt**
(`{consented_at, clip_sha256, statement}` in the Voice's metadata) on **every**
clone path: studio ingestion (`service/ingest.py`), the direct `POST /v1/voices`
upload (`service/voices.py`), and the landing's hero mic demo. One canonical
statement is the single source of truth (`web/lib/consent.ts`), so the record
always reflects what was actually agreed — and `GET /v1/voices` reports whether
a voice carries a receipt.

### Audible docs — `POST /v1/narrate` and the one-line embed

Turn any page into a narration **plan**: an ordered list of blocks, each with
the emotion it should be read with and the Character role it wants. It renders
nothing — every block is synthesized lazily through the ordinary
`/v1/speak` / `/v1/text-to-speech` routes, so admission, caching and the emotion
fallback report all behave exactly as they do everywhere else.

```bash
# A markdown or HTML body needs no configuration at all.
curl -s -X POST localhost:8080/v1/narrate -H "xi-api-key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"markdown":"# Getting started\n\nInstall it with pip.","character_id":"alba"}'
# -> {"narration_id":"...","blocks":[{"text":"...","emotion":"excited",
#     "character_hint":"warm","tagged_text":"[excited]...[/excited]",
#     "addressing":{"speak":{"route":"/v1/speak", ...}}}], ...}

curl -s localhost:8080/v1/narrate/<narration_id> -H "xi-api-key: $KEY"
```

**Remote URLs are off by default.** `{"url": "..."}` is refused unless an
operator opts in per host:

| variable | default | meaning |
|---|---|---|
| `NARRATE_ALLOW_HOSTS` | *(empty)* | comma-separated hosts the service may fetch. A leading dot is a suffix rule (`.example.com` allows `docs.example.com`, **not** `example.com`). Empty = markdown/HTML bodies only. |
| `NARRATE_MAX_BYTES` | `1048576` | page size cap |
| `NARRATE_TIMEOUT_S` | `8` | fetch deadline |

Even on an allowlisted host the fetch refuses private, loopback, link-local
(`169.254.169.254` — the cloud metadata endpoint), CGNAT and reserved
addresses, re-checks **every redirect hop**, and caps redirects at 3. Every
refusal is a named sentence ending in *"paste the text instead"*, which is the
honest degrade when extraction or fetching cannot work.

**The site's own dock.** `web/components/ui/NarrationDock.tsx` narrates the
landing and `/benchmarks` from a registry derived from the same modules those
pages render from — and plays an arbitrary plan with `?narration=<id>`.
Nothing ever plays without a click; `?narrate=1` only *arms* the dock.

**Baked audio.** `npm run bake:narration` (in `web/`) renders the registry once
against a local service and writes `public/narration/<clipKey>.wav` plus a
manifest the dock prefers over synthesis — so a page reading costs static files
rather than ~40 synth slots per visitor. It is incremental, prunes clips the
copy no longer contains, and degrades to a **named no-op** (exit 0) when the
service is unreachable or unkeyed. `--strict` makes a release pipeline fail
instead; `--character=<id>` pins the narrator.

**The embed.** `web/public/narrate.js` puts the same dock on any site:

```html
<script src="https://your-gravitone/narrate.js"
        data-host="https://your-gravitone"
        data-voice="alba"></script>
```

It is dependency-free, under 15 KB, lives in a shadow root, contains **no
secrets** (it asks the reader for their own key and keeps it in `sessionStorage`
for that tab only), talks to `data-host` and nowhere else, and never autoplays.
It reads the reader's selection when there is one, otherwise the page's
`<article>`/`<main>`.

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
| **CPU-index torch** | `pip install torch --index-url https://download.pytorch.org/whl/cpu` | avoids PyPI's aarch64 CUDA (GH200) wheel whose CPU fallback bypasses ACL; **~8%** single-stream on `t4g.small` — one unlogged observation, not a certified row (see "Two findings that generalise") |
| **oneDNN + Arm Compute Library** | default in the CPU-index aarch64 wheel / `armswdev/pytorch-arm-neoverse` | ACL GEMM kernels for fp32/bf16 |
| **BF16 fast-math** | `ONEDNN_DEFAULT_FPMATH_MODE=bf16` | fp32 matmuls dispatched to BF16 kernels on Neoverse (BF16/I8MM HW) |
| **KleidiAI** | Kleidi-enabled aarch64 PyTorch wheel | automatic inference uplift, no code change |
| **int8 quantization** | `TTS_QUANTIZE=true` — **off by default** | **no Arm measurement exists**, so this repo quotes no figure. On aarch64 int8 comes from a different backend (qnnpack/XNNPACK) than the fp32 path (oneDNN + ACL), so the x86 (fbgemm) numbers this repo once quoted do not transfer. `benchmark_arm_ab.sh` has a `quantize` row — flip it on for a box only once that row shows a win. Rationale: `service/config.py` |
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
