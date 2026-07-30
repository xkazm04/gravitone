"""Runtime configuration for the Pocket TTS service.

Everything is env-overridable so the load-test harness can sweep the knobs
(worker count, torch threads, queue depth, quantization) without code edits.
These are the exact dials your perf tests will move to find the cap.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_env_file() -> None:
    """Fill os.environ from REPO_ROOT/.env (KEY=VALUE lines, # comments).

    Real environment variables win over .env entries. No python-dotenv
    dependency; this runs before Settings' field defaults are evaluated.
    """
    env_path = REPO_ROOT / ".env"
    if not env_path.is_file():
        return
    for raw in env_path.read_text("utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


_load_env_file()


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


def _str(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    # --- Concurrency model -------------------------------------------------
    # WORKERS independent model instances process requests in parallel.
    # Generation is NOT thread-safe (see tts_model.py docstrings), so each
    # worker owns its own TTSModel. This is the hard parallelism ceiling.
    #
    # Default is 1: the model is GIL/serialization-bound, so the load-test and
    # certification harnesses (service.loadtest / service.certify) recommend
    # scaling by PROCESS, not in-process worker. Run N single-worker replicas
    # with `python -m service.replicas --replicas N` rather than raising this.
    workers: int = _int("TTS_WORKERS", 1)
    # Extra requests allowed to WAIT in the queue once all workers are busy.
    # Beyond (workers + queue_max) in flight -> HTTP 429 (backpressure).
    queue_max: int = _int("TTS_QUEUE_MAX", 32)
    # torch intra-op threads (process-global). Rule of thumb to avoid CPU
    # oversubscription: workers * torch_threads ~= physical cores.
    #
    # The default is a conservative 4 and is NOT derived from os.cpu_count():
    # the shipped topology sizes this per replica (replicas.per_replica_threads
    # splits the cores N ways and exports TTS_TORCH_THREADS before the child
    # imports torch). Raise it only for a single-process run on a bigger box.
    torch_threads: int = _int("TTS_TORCH_THREADS", 4)
    # torch INTER-op threads (the parallel-region scheduler pool). Distinct
    # from torch_threads, and never set before: the default is one pool sized
    # to every core, which on the replica topology means N replicas x cores
    # scheduler threads fighting over cores that were deliberately pinned.
    # A replica runs ONE generation at a time and pocket-tts is a sequential
    # decode loop, so inter-op parallelism buys nothing here.
    #   1  (default) — one scheduler thread, no oversubscription
    #   0            — leave torch's default untouched (the pre-Arm-pass path)
    # Applied best-effort: torch only accepts it before the first parallel
    # region, so a late call is logged and ignored (see engine._apply_cpu_tuning).
    torch_interop_threads: int = _int("TTS_TORCH_INTEROP_THREADS", 1)
    # Flush denormal floats to zero. Denormals arise in the near-silent tails of
    # generated audio and cost 10-100x on a normal FPU path; the output
    # difference is far below the 16-bit PCM quantization step. Set
    # TTS_FLUSH_DENORMAL=0 to revert to IEEE-exact denormal handling.
    flush_denormal: bool = _bool("TTS_FLUSH_DENORMAL", True)
    # Wrap generation in torch.inference_mode() (cheaper than no_grad: skips
    # version counters and view tracking as well as autograd). Set
    # TTS_INFERENCE_MODE=0 to fall back to plain torch.no_grad(). The engine
    # ALSO falls back on its own if the model turns out to cache tensors across
    # calls in a way inference_mode rejects — see engine._generation_context.
    inference_mode: bool = _bool("TTS_INFERENCE_MODE", True)

    # --- Model -------------------------------------------------------------
    language: str = _str("TTS_LANGUAGE", "english")
    # Dynamic int8 quantization of the model, off by default.
    #
    # What is actually known: the ~27% figure this comment used to quote came
    # from an x86 (fbgemm) run and says nothing about this product's target.
    # On aarch64 the int8 kernels come from a DIFFERENT backend (qnnpack /
    # XNNPACK) than the fp32 path (oneDNN + Arm Compute Library, plus KleidiAI
    # on recent builds), so the x86 ratio does not transfer in either
    # direction. No Arm measurement exists yet, so the flag stays OFF: shipping
    # a quantized default we have not measured would trade audio quality for an
    # unverified speedup. `benchmark_arm_ab.sh` measures it; flip this on for a
    # box only once its A/B row shows a win.
    quantize: bool = _bool("TTS_QUANTIZE", False)
    # Backend that serves those int8 kernels when quantize=True. torch's default
    # engine is chosen at build time and on some aarch64 wheels is still the
    # x86-oriented one, which silently means slow (or unsupported) int8 ops.
    #   "auto" (default) — prefer qnnpack on aarch64 if the build supports it
    #   ""               — leave torch's own choice alone
    #   "<name>"         — force a specific engine (qnnpack, onednn, fbgemm, x86)
    # Ignored entirely when quantize is off.
    quantized_engine: str = _str("TTS_QUANTIZED_ENGINE", "auto")
    # Directory of pre-exported voice embeddings (*.safetensors) to preload.
    voices_dir: str = _str("TTS_VOICES_DIR", str(REPO_ROOT / "voices"))
    # Durable working dir for ingest jobs (per-job subdir + state.json). Kept
    # off OS tempdirs so jobs survive a restart and are GC'd on a TTL timer.
    ingest_work_dir: str = _str("INGEST_WORK_DIR", str(REPO_ROOT / "ingest_jobs"))
    # How many ingest jobs may be doing WORK (analyzing, labelling, cloning) at
    # once. Nothing used to bound this: every upload spawned a raw thread, and
    # each running job fans out to LABEL_WORKERS ffmpeg extracts plus one paid
    # cloud call per segment (up to ~40) — so N simultaneous uploads multiplied
    # both the CPU load on an Arm box and the external bill by N. Over the limit
    # the ingest routes answer 429 (retry), they do not queue.
    # PER PROCESS, like every other in-memory ingest structure: the service runs
    # as N single-worker replicas and JOBS is not shared (deploy/README.md,
    # "Ingest is replica-affine"), so the fleet-wide ceiling is this × replicas.
    ingest_max_jobs: int = _int("INGEST_MAX_JOBS", 2)
    # Longest recording accepted for ingest. Enforced by /scan BEFORE anything
    # is paid for: Scribe and the Isolator both bill by duration, so an
    # unbounded clip is an unbounded invoice (there was a floor but no ceiling).
    # 15 min is generous next to the 50 MB upload cap and the 40-segment
    # labelling limit. A recording whose duration cannot be probed is REJECTED,
    # not waved through — the gate fails closed.
    ingest_max_clip_seconds: float = float(_str("INGEST_MAX_CLIP_SECONDS", "900"))
    # How many segments one Gemini labelling request carries. Labelling used to
    # be one request per segment (40 per job); batching cuts that by ~this
    # factor. The effective size shrinks so that a small job still fills the
    # label pool (see ingest._batches).
    ingest_label_batch: int = _int("INGEST_LABEL_BATCH", 8)
    # Attempts per external call (1 = no retry) on transient failures only —
    # 429/5xx/timeouts. A 4xx that means "this request is wrong" is permanent
    # and is never retried.
    ingest_retry_attempts: int = _int("INGEST_RETRY_ATTEMPTS", 3)
    # Retries allowed across a WHOLE ingest job, shared by every provider. The
    # per-call attempt count alone would let a genuinely-down provider multiply
    # the job's spend by `retry_attempts`; this is the circuit breaker that
    # makes a failing provider fail fast instead of expensively.
    ingest_job_retry_budget: int = _int("INGEST_JOB_RETRY_BUDGET", 12)
    # How many low-confidence segments a job may escalate to the (much dearer)
    # pro model. Escalation was uncapped and uncounted: every segment under the
    # confidence threshold silently doubled its own bill.
    ingest_escalation_budget: int = _int("INGEST_ESCALATION_BUDGET", 12)
    # Fallback built-in voice if a requested voice_id isn't found.
    default_voice: str = _str("TTS_DEFAULT_VOICE", "alba")
    # --- Piper voices (service/piper.py) -----------------------------------
    # A SECOND synthesis engine, for the languages Pocket TTS does not speak
    # (it does English and French; the transcriber understands dozens). Nothing
    # is required: an empty directory means no Piper voices and every caller
    # falls through to the Pocket TTS pool exactly as before.
    #   python -m piper.download_voices --download-dir piper_voices cs_CZ-jirka-medium
    piper_voices_dir: str = _str("PIPER_VOICES_DIR", str(REPO_ROOT / "piper_voices"))

    # --- Generation defaults ----------------------------------------------
    # Passed to TTSModel.generate_audio(max_tokens=...) for EVERY job. No HTTP
    # route exposes it (engine.submit's max_tokens parameter has no caller), so
    # despite the old "overridable per request" wording this is a process-wide
    # constant today; change it with the env var, not a request field.
    max_tokens: int = _int("TTS_MAX_TOKENS", 50)

    # --- External encoder --------------------------------------------------
    # Threads ffmpeg may use for the mp3 encode. The launcher pins each
    # replica's inference thread budget to a slice of the cores; ffmpeg,
    # spawned per mp3 request, otherwise defaults to "as many threads as there
    # are cores" and oversubscribes exactly those pinned cores mid-generation.
    # libmp3lame is single-threaded anyway, so 1 costs nothing.
    #   0 — let ffmpeg decide (the pre-Arm-pass behaviour)
    ffmpeg_threads: int = _int("TTS_FFMPEG_THREADS", 1)

    # --- Long-form segmentation -------------------------------------------
    # Target size, in characters, of ONE synthesis unit. Long text is
    # sentence-split and neighbouring sentences are coalesced up to this budget.
    # This is a TARGET, not a bound on the number of units: greedy coalescing
    # only merges when the combined length fits, so sentences longer than half
    # the budget never merge and the count tracks sentence count.
    #
    # Who actually splits, and why:
    #   * the STREAMING route always does. Its rolling window costs no extra
    #     admission and finer units mean a lower time-to-first-byte even on ONE
    #     worker (first-segment time instead of whole-body time).
    #   * the batching drop-in route only when `workers` > 1, because it submits
    #     every unit at once and a unit past the worker count merely queues
    #     behind its own siblings while still costing an admission slot and a
    #     concat seam (app._max_batch_units caps it at the real worker count).
    #     At the shipped workers=1 a long body therefore stays ONE job on that
    #     route — exactly the pre-segmentation path, identical bytes and
    #     headers, as short text always was.
    # Set this for PROSODY (how long a natural span is); let _max_batch_units
    # own admission safety.
    chunk_chars: int = _int("TTS_CHUNK_CHARS", 350)

    # --- Synthesis result cache -------------------------------------------
    # Byte budget for the LRU of finished audio (see service/cache.py). 0
    # disables the cache AND its single-flight collapsing.
    #
    # Defaults ON at 128 MiB. Rationale: re-rendering identical text is pure
    # waste on a CPU-only box, the key includes a fingerprint of the voice's
    # safetensors (so a re-clone can never serve stale audio), and the budget is
    # small next to a loaded model. Note it is PER PROCESS — the service runs as
    # N single-worker replicas, so plan for cache_bytes × replicas of RSS.
    cache_bytes: int = _int("TTS_CACHE_BYTES", 128 * 1024 * 1024)

    # --- Speech to text (local, faster-whisper) ----------------------------
    # The transcriber behind /v1/speech-to-text and the ConvAI session's ears.
    # Local by construction: CTranslate2 int8 on CPU, weights cached on disk,
    # nothing leaves the machine. This is the half of the product the ingest
    # pipeline had to buy from ElevenLabs Scribe (service/ingest.py, CLOUD
    # mode); sovereign mode simply had no transcript at all.
    #
    # Size is the accuracy/latency dial, and the default is deliberate: "small"
    # is the smallest model that reliably keeps domain nouns intact ("React",
    # "PostgreSQL"), which is the whole point of transcribing an interview.
    # "base" is ~2x faster and noticeably worse at exactly those words; "tiny"
    # is for smoke tests. Weights download on FIRST use (~460 MB for small).
    stt_model: str = _str("STT_MODEL", "small")
    # int8 is the CPU-sane default (CTranslate2 quantizes on load). "float32"
    # is the reference path; "int8_float32" trades some memory for accuracy.
    stt_compute_type: str = _str("STT_COMPUTE_TYPE", "int8")
    stt_device: str = _str("STT_DEVICE", "cpu")
    # Beam width. 1 (greedy) is ~2x faster than the library default of 5 and is
    # the right trade for conversational turns, where latency IS the product.
    # Raise it for offline batch transcription of a recording.
    stt_beam_size: int = _int("STT_BEAM_SIZE", 1)
    # Threads CTranslate2 may use. Shares a box with the TTS worker pool, so it
    # is pinned for the same reason ffmpeg_threads is: an unpinned transcriber
    # oversubscribes exactly the cores the launcher gave to inference.
    stt_threads: int = _int("STT_THREADS", 4)
    # Where model weights are cached. Empty = the HuggingFace default
    # (~/.cache/huggingface), shared with the TTS weights.
    stt_download_root: str = _str("STT_DOWNLOAD_ROOT", "")
    # Longest clip /v1/speech-to-text will accept. Whisper is ~5-10x realtime on
    # CPU, so an unbounded upload is an unbounded request. 15 min matches
    # ingest_max_clip_seconds — the same recording, the same ceiling.
    stt_max_clip_seconds: float = float(_str("STT_MAX_CLIP_SECONDS", "900"))

    # --- Speaker diarization (service/diarize.py) --------------------------
    # Who spoke when. sherpa-onnx + pyannote-segmentation-3.0 (MIT) + WeSpeaker
    # CAM++ (Apache-2.0), all from unauthenticated GitHub releases — chosen over
    # pyannote.audio precisely because its pretrained pipelines need a
    # HuggingFace account and token, which this service cannot require.
    #   python -m service.diarize --download        (~34 MB, once)
    diarize_models_dir: str = _str("DIARIZE_MODELS_DIR",
                                   str(REPO_ROOT / "diarization_models"))
    diarize_threads: int = _int("DIARIZE_THREADS", 1)
    # Cosine distance at which two voices are called different people — the only
    # knob that genuinely moves the answer (sherpa-onnx's num_clusters does not
    # produce the count you ask for; see service/diarize.py). 0.6 is measured,
    # not guessed: in a 0.4-0.8 sweep it was the only value that got BOTH of
    # sherpa-onnx's labelled human fixtures exactly right.
    diarize_threshold: float = float(_str("DIARIZE_THRESHOLD", "0.6"))
    diarize_min_speech_s: float = float(_str("DIARIZE_MIN_SPEECH_S", "0.3"))
    diarize_min_silence_s: float = float(_str("DIARIZE_MIN_SILENCE_S", "0.5"))

    # --- Conversational agent (ConvAI) -------------------------------------
    # The ElevenLabs-Agents-shaped WebSocket surface: ears (stt) + brain (an
    # LLM) + mouth (the TTS pool) in one duplex session. See service/convai.py.
    convai_enabled: bool = _bool("CONVAI_ENABLED", True)
    # Which brain answers. Defaults to "scripted" ON PURPOSE: it needs no LLM,
    # no network and no extra install, and a canned interviewer is what an
    # automated test actually wants — deterministic turns make transcript and
    # latency assertions mean something. Point it at a real model
    # (CONVAI_LLM=openai-compat + a local Ollama / LM Studio) for realism.
    # `GET /v1/convai/agents` reports which one is live, so nobody has to guess.
    #   "scripted"      — fixed turns, no model (the default; see above)
    #   "claude-cli"     — the `claude` CLI headless, on the machine's own
    #                      subscription. No key, no server, no download; costs
    #                      ~4-6 s per turn instead of ~1.6 s.
    #   "openai-compat" — any local /chat/completions server
    convai_llm: str = _str("CONVAI_LLM", "scripted")
    # The Claude CLI brain (service/dialog.ClaudeCliBackend).
    claude_cli_command: str = _str("CLAUDE_CLI_COMMAND", "claude")
    # "haiku" is the fastest tier and a screening question does not need more.
    # Empty string uses whatever the CLI is configured to default to.
    claude_cli_model: str = _str("CLAUDE_CLI_MODEL", "haiku")
    # Per-turn ceiling. Generous next to a ~5 s turn because a cold CLI start on
    # a loaded box is slow, and a killed turn costs the whole conversation.
    claude_cli_timeout_s: float = float(_str("CLAUDE_CLI_TIMEOUT_S", "60"))
    # Any OpenAI-compatible /chat/completions server. Ollama's default port.
    convai_llm_base_url: str = _str("CONVAI_LLM_BASE_URL", "http://127.0.0.1:11434/v1")
    convai_llm_model: str = _str("CONVAI_LLM_MODEL", "llama3.2")
    convai_llm_api_key: str = _str("CONVAI_LLM_API_KEY", "")
    # Ceiling on ONE reply. A conversational turn that takes longer than this
    # has already failed the conversation, whatever it eventually says.
    convai_llm_timeout_s: float = float(_str("CONVAI_LLM_TIMEOUT_S", "45"))
    # Per-reply token budget. Interview turns are short; an unbounded reply is a
    # minute of synthesis the caller has to sit through.
    convai_llm_max_tokens: int = _int("CONVAI_LLM_MAX_TOKENS", 220)
    # Agent definitions (JSON, one per file). Alongside voices/, takes/, ... so
    # a deployment mounts ONE data volume. BUILTIN_AGENTS ships a working
    # interviewer, so an empty directory is a valid installation.
    convai_agents_dir: str = _str("CONVAI_AGENTS_DIR", str(REPO_ROOT / "agents"))
    # Base URL clients should dial back on, for deployments where the address
    # the browser uses is NOT the address this process sees (a reverse proxy, a
    # container port map). Empty = derive it from the mint request, which is
    # right for every direct-connection case including localhost.
    #   CONVAI_PUBLIC_URL="https://tts.example.com"  -> wss://tts.example.com/...
    convai_public_url: str = _str("CONVAI_PUBLIC_URL", "")
    # How long a minted signed URL stays valid. It is a connect ticket, not a
    # session credential: the client dials immediately, so a short life bounds
    # the damage from a leaked URL (the WS cannot carry an auth header, which is
    # exactly why this ticket exists — see convai.mint_ticket).
    convai_ticket_ttl_s: int = _int("CONVAI_TICKET_TTL_S", 120)
    # Concurrent conversations this replica will hold. Each one owns a
    # transcriber and competes for the TTS pool, so the honest cap is small;
    # over it the WS is closed at once rather than queued (a conversation that
    # waits is a conversation that failed).
    convai_max_sessions: int = _int("CONVAI_MAX_SESSIONS", 4)
    # Whole-conversation ceiling (seconds). A wedged or abandoned socket costs a
    # session slot forever without it. 30 min is longer than any interview.
    convai_session_max_s: float = float(_str("CONVAI_SESSION_MAX_S", "1800"))
    # Silence (no user speech, no agent turn) that ends a conversation.
    convai_idle_timeout_s: float = float(_str("CONVAI_IDLE_TIMEOUT_S", "300"))
    # Sample rate for BOTH directions of the audio stream, announced in
    # conversation_initiation_metadata as pcm_{rate}. 16 kHz is what ElevenLabs
    # agents use, what Whisper wants natively, and what the browser SDK expects;
    # the TTS pool's 24 kHz output is resampled down on the way out.
    convai_audio_rate: int = _int("CONVAI_AUDIO_RATE", 16000)
    # Server->client ping cadence and how many unanswered pings end the session.
    # Same shape as the ElevenLabs ping/pong: it is the only liveness signal on
    # a socket where silence is also a legitimate state.
    convai_ping_interval_s: float = float(_str("CONVAI_PING_INTERVAL_S", "20"))
    convai_ping_max_missed: int = _int("CONVAI_PING_MAX_MISSED", 3)
    # Write each conversation's audio and transcript to disk (service/recording.py).
    # OFF by default and deliberately so: this service's claim is that audio does
    # not leave the machine, and recording every caller unasked is a DIFFERENT
    # promise that belongs to an operator, not to a default. Turn it on for test
    # runs, where the recording is the deliverable.
    convai_record: bool = _bool("CONVAI_RECORD", False)
    convai_recordings_dir: str = _str("CONVAI_RECORDINGS_DIR",
                                      str(REPO_ROOT / "recordings"))

    # --- Server ------------------------------------------------------------
    host: str = _str("TTS_HOST", "127.0.0.1")
    # Level for this service's OWN logs (the `gravitone` logger tree), applied
    # by app.main. Separate from uvicorn's request log, which it does not touch.
    log_level: str = _str("TTS_LOG_LEVEL", "info")
    port: int = _int("TTS_PORT", 8080)
    # Optional shared secret; if set, requests must send it as `xi-api-key`
    # (ElevenLabs-compatible header). Empty = open (local dev).
    api_key: str = _str("TTS_API_KEY", "")
    # --- Private surface ---------------------------------------------------
    # Interactive API docs (/docs, /redoc) and the OpenAPI schema
    # (/openapi.json). FastAPI publishes all three by default, which on a
    # key-protected deployment hands any anonymous visitor the complete
    # catalogue of every route — including /v1/keys — with a Try-It-Out button.
    #   "auto" (default) — ON in open mode (no TTS_API_KEY: local dev, where
    #                      the docs are the point), OFF as soon as a key is set
    #   "on"             — always published (a deliberately public API)
    #   "off"            — never published
    # The schema is what the docs pages render, so all three go together.
    docs: str = _str("TTS_DOCS", "auto")
    # Whether an unauthenticated LOOPBACK caller may read /metrics when a key
    # IS configured. On by default because the shipped topology needs it: the
    # replica launcher (service/replicas.py) aggregates each replica's /metrics
    # from the supervisor process over 127.0.0.1 with a stdlib urlopen that
    # carries no credential.
    # Set to 0 when anything ELSE can originate a loopback request — most
    # importantly a reverse proxy on the same host, which makes every request
    # in the world look local. Off-host scrapers (KEDA, Prometheus) always need
    # a key regardless of this setting.
    metrics_allow_loopback: bool = _bool("TTS_METRICS_ALLOW_LOOPBACK", True)

    # --- Browser access (CORS) ---------------------------------------------
    # Which browser ORIGINS may call this API directly. The "drop-in
    # ElevenLabs" claim only holds for browser clients if the preflight
    # succeeds, so this is the knob that makes the JS SDK usable.
    #
    # DEFAULT IS CLOSED (empty). Nothing is allowed cross-origin until an
    # operator names their origin — this service also mounts /v1/keys (key
    # issuance) and /v1/ingest (clone uploads), and a wildcard default there
    # would hand every page on the internet a free synthesis (and upload)
    # endpoint. Server-to-server clients and the studio's own Next.js proxy
    # are unaffected: CORS is a browser rule, not a firewall.
    #
    #   TTS_CORS_ORIGINS="https://studio.example.com,http://localhost:3000"
    #     comma-separated EXACT origins (scheme + host + port, no path, no
    #     trailing slash). This is the normal setting.
    #   TTS_CORS_ORIGINS="*"
    #     allowed, but logged as a warning at startup: any page anywhere may
    #     spend this box's CPU. Only sane for a deliberately public,
    #     rate-limited deployment.
    #   TTS_CORS_ORIGIN_REGEX="https://.*\.example\.com"
    #     for per-tenant subdomains; anchored by Starlette with fullmatch.
    #   TTS_CORS_ALLOW_CREDENTIALS=1
    #     only if a browser client must send COOKIES. API keys travel in the
    #     xi-api-key / Authorization headers, which need no credentials mode,
    #     and the CORS spec forbids credentials together with "*" — so this is
    #     off by default and refused (with a warning) when origins is "*".
    cors_origins: str = _str("TTS_CORS_ORIGINS", "")
    cors_origin_regex: str = _str("TTS_CORS_ORIGIN_REGEX", "")
    cors_allow_credentials: bool = _bool("TTS_CORS_ALLOW_CREDENTIALS", False)
    # How long a browser may cache a preflight (seconds). Every cross-origin
    # POST costs an extra OPTIONS round trip until it does.
    cors_max_age: int = _int("TTS_CORS_MAX_AGE", 600)

    # How long a request will wait for a worker before giving up (seconds).
    request_timeout_s: float = float(_str("TTS_REQUEST_TIMEOUT_S", "120"))
    # Whole-request ceiling for a STREAMING synthesis (seconds).
    # request_timeout_s is a per-job ceiling; applied per segment it bounded
    # nothing at the request level — a 20-segment stream could legitimately run
    # 20 × 120s. This is the one deadline the streaming route enforces: when it
    # expires the response is terminated and every un-consumed segment is
    # abandoned. Sized for a full script (the request cap is 8000 chars), not
    # for a single utterance.
    stream_deadline_s: float = float(_str("TTS_STREAM_DEADLINE_S", "600"))
    # How many segments of ONE stream may sit in the engine at a time. 0 = auto
    # (workers + 1: enough to keep every worker fed plus one in reserve, while
    # leaving the rest of the admission window for other callers). A stream
    # submits in this rolling window instead of all at once, so script length no
    # longer decides admission — see text_to_speech_stream.
    stream_window: int = _int("TTS_STREAM_WINDOW", 0)
    # How long graceful shutdown waits for in-flight generations to finish.
    # This is ONE link in a chain that must be ordered longest-last:
    #   drain_timeout_s  <  container stop grace (docker stop -t / k8s
    #   terminationGracePeriodSeconds)
    # If the orchestrator's grace is shorter, it SIGKILLs mid-drain and the
    # careful shutdown in engine.stop() never gets to finish. Queued jobs are
    # failed fast with 503 regardless, so this only bounds the wait for
    # generations already inside the model (request_timeout_s is the caller's
    # own ceiling and is deliberately independent of this one).
    drain_timeout_s: float = float(_str("TTS_DRAIN_TIMEOUT_S", "20"))


SETTINGS = Settings()
