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
    workers: int = _int("TTS_WORKERS", 2)
    # Extra requests allowed to WAIT in the queue once all workers are busy.
    # Beyond (workers + queue_max) in flight -> HTTP 429 (backpressure).
    queue_max: int = _int("TTS_QUEUE_MAX", 32)
    # torch intra-op threads (process-global). Rule of thumb to avoid CPU
    # oversubscription: workers * torch_threads ~= physical cores.
    torch_threads: int = _int("TTS_TORCH_THREADS", 4)

    # --- Model -------------------------------------------------------------
    language: str = _str("TTS_LANGUAGE", "english")
    quantize: bool = _bool("TTS_QUANTIZE", False)  # int8; ~27% faster on x86
    # Directory of pre-exported voice embeddings (*.safetensors) to preload.
    voices_dir: str = _str("TTS_VOICES_DIR", str(REPO_ROOT / "voices"))
    # Fallback built-in voice if a requested voice_id isn't found.
    default_voice: str = _str("TTS_DEFAULT_VOICE", "alba")

    # --- Generation defaults (overridable per request) --------------------
    max_tokens: int = _int("TTS_MAX_TOKENS", 50)

    # --- Server ------------------------------------------------------------
    host: str = _str("TTS_HOST", "127.0.0.1")
    port: int = _int("TTS_PORT", 8080)
    # Optional shared secret; if set, requests must send it as `xi-api-key`
    # (ElevenLabs-compatible header). Empty = open (local dev).
    api_key: str = _str("TTS_API_KEY", "")
    # How long a request will wait for a worker before giving up (seconds).
    request_timeout_s: float = float(_str("TTS_REQUEST_TIMEOUT_S", "120"))


SETTINGS = Settings()
