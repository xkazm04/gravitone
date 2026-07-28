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
    # Fallback built-in voice if a requested voice_id isn't found.
    default_voice: str = _str("TTS_DEFAULT_VOICE", "alba")

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

    # --- Server ------------------------------------------------------------
    host: str = _str("TTS_HOST", "127.0.0.1")
    port: int = _int("TTS_PORT", 8080)
    # Optional shared secret; if set, requests must send it as `xi-api-key`
    # (ElevenLabs-compatible header). Empty = open (local dev).
    api_key: str = _str("TTS_API_KEY", "")
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
