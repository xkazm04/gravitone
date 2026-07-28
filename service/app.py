"""ElevenLabs-shaped HTTP API in front of the Pocket TTS worker pool.

Endpoints (compatible with common ElevenLabs client code):
  POST /v1/text-to-speech/{voice_id}          -> audio bytes (wav|mp3)
  GET  /v1/voices                             -> list available voices
  GET  /health                                -> readiness + live pool metrics
  GET  /metrics                               -> raw counters for the load test

Request body mirrors ElevenLabs:
  { "text": "...", "model_id": "pocket_tts",
    "voice_settings": { "temperature": 0.7 } }
`output_format` is a query param (elevenlabs-style): wav_24000 | mp3_24000_128 | pcm_24000.
Auth: enforced when TTS_API_KEY is set (see service/auth.py) — the root key or
a managed `/v1/keys` key via `xi-api-key` / `Authorization: Bearer`.
"""
from __future__ import annotations

import asyncio
import logging
import re
import struct
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

import base64
import json

from service.auth import require_read_write, require_scope
from service import errors
from service.cache import CachedAudio, SynthCache
from service.config import SETTINGS
from service.demand import record_fallback
from service.emotions import parse_segments, resolve
from service.engine import (
    AdmissionRejected, ShuttingDown, TtsEngine, concat_wavs,
    resample_pcm16, resample_wav_bytes, wav_bytes_to_mp3,
)
from service.voices import BUILTIN, emotion_map, router as voices_router
from service.keys import router as keys_router
from service.ingest_api import (
    router as ingest_router, start_background as ingest_start_background,
)
from service.packs import router as packs_router
from service.takes import router as takes_router, reviews_router

ENGINE: TtsEngine | None = None

# Finished audio, keyed on full request identity (_cache_key). PER PROCESS: the
# service runs as N single-worker replicas, so a hit here is a hit for this
# replica only. See service/cache.py.
SYNTH_CACHE = SynthCache(SETTINGS.cache_bytes)

logger = logging.getLogger("gravitone")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global ENGINE
    ENGINE = TtsEngine()
    # Ingest job rehydration + the GC sweeper used to run as import side
    # effects; they belong to the app's lifecycle, not to `import`.
    await asyncio.get_event_loop().run_in_executor(None, ingest_start_background)
    # Model loading is blocking; do it off the event loop.
    await asyncio.get_event_loop().run_in_executor(None, ENGINE.start)
    yield
    # Graceful drain: stop admitting, fail queued jobs fast (no caller hangs on
    # the request timeout), let in-flight generations finish, join workers.
    # The budget is configurable so it can be kept under the orchestrator's
    # stop grace (see Settings.drain_timeout_s).
    await asyncio.get_event_loop().run_in_executor(
        None, ENGINE.stop, SETTINGS.drain_timeout_s)


app = FastAPI(title="Pocket TTS Service", version="1.0.0", lifespan=lifespan)

# Unhandled exceptions keep the {"detail"} JSON contract (sanitized request-id
# body) instead of escaping to Starlette's plain-text page.
errors.install_catch_all(app)


@app.exception_handler(ShuttingDown)
async def _shutting_down_handler(request: Request, exc: ShuttingDown):
    """A submit refused because the pool is draining -> 503 + Retry-After."""
    return JSONResponse(status_code=503, content={"detail": "server shutting down"},
                        headers={"Retry-After": "1"})


class VoiceSettings(BaseModel):
    """Expression controls.

    Pocket TTS has no emotion/style/speed parameter — expression lives in the
    reference audio. What IS tunable are the sampling knobs below, which the
    engine applies to the worker's model instance per request.

    ElevenLabs compatibility — accepted-but-inert settings:
        `similarity_boost` and `style` are part of the ElevenLabs VoiceSettings
        contract, so clients send them. Pocket TTS exposes only three sampling
        knobs (temperature -> temp, stability -> noise_clamp, quality ->
        lsd_decode_steps), each already claimed by the setting of the same
        intent above. There is NO honest, non-colliding knob left for
        similarity_boost (reference adherence) or style (style exaggeration),
        so rather than silently pretend to apply them we accept them and treat
        them as inert. When a client sends either, the response carries an
        `X-Ignored-Settings: similarity_boost,style` header so the no-op is
        visible, never silent. If pocket-tts later exposes a reference-adherence
        or style knob, map it here and drop the name from `_ignored_settings`.
    """
    # 0.5 (consistent) .. 1.0 (expressive). Model default 0.7.
    temperature: float | None = None
    # 0 (off) .. 1 (tight). Mapped to the model's `noise_clamp`.
    stability: float | None = None
    # 1 (fast) .. 5 (best). Mapped to `lsd_decode_steps`; costs realtime factor.
    quality: int | None = None
    # Accepted for ElevenLabs compatibility; inert (see class docstring). A
    # request that sets either is reported via the X-Ignored-Settings header.
    similarity_boost: float | None = None
    style: float | None = None


def _overrides(vs: VoiceSettings | None) -> dict:
    """Map user-facing expression settings onto model attributes."""
    o: dict = {}
    if vs is None:
        return o
    if vs.temperature is not None:
        o["temp"] = max(0.1, min(1.5, float(vs.temperature)))
    if vs.stability is not None:
        s = max(0.0, min(1.0, float(vs.stability)))
        # 0 -> no clamp (wild); 1 -> tight clamp (stable)
        o["noise_clamp"] = None if s < 0.01 else round(2.5 - 2.0 * s, 2)
    if vs.quality is not None:
        o["lsd_decode_steps"] = max(1, min(5, int(vs.quality)))
    return o


def _ignored_settings(vs: VoiceSettings | None) -> list[str]:
    """ElevenLabs VoiceSettings fields we accept but cannot honestly honour.

    Returns the names actually present on this request (so the header only
    appears when a client really sent one), preserving a stable order."""
    if vs is None:
        return []
    ignored = []
    if vs.similarity_boost is not None:
        ignored.append("similarity_boost")
    if vs.style is not None:
        ignored.append("style")
    return ignored


def _ignored_headers(vs: VoiceSettings | None) -> dict[str, str]:
    """{'X-Ignored-Settings': 'similarity_boost,style'} or {} if none ignored."""
    names = _ignored_settings(vs)
    return {"X-Ignored-Settings": ",".join(names)} if names else {}


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=8000)
    model_id: str | None = "pocket_tts"
    voice_settings: VoiceSettings | None = None
    frames_after_eos: int | None = None


async def _await_result(job):
    """Await one engine Job's result without parking a thread.

    The engine hands back a concurrent.futures.Future; asyncio.wrap_future
    bridges it to the event loop with a done-callback — no default-executor
    thread is blocked per in-flight request (the old run_in_executor(None,
    future.result) parked one thread each). Raises the endpoint-shaped errors.
    """
    try:
        return await asyncio.wait_for(
            asyncio.wrap_future(job.future),
            timeout=SETTINGS.request_timeout_s,
        )
    except asyncio.TimeoutError:
        if ENGINE is not None:
            ENGINE.metrics.on_timeout()
        # Signal the worker pool the caller has given up: a job still queued
        # will be skipped un-run (permit freed immediately) instead of burning
        # a full generation no one will read. A job already inside the model
        # runs to completion (generate_audio is atomic — no cancel point).
        abandoned = getattr(job, "abandoned", None)
        if abandoned is not None:
            abandoned.set()
        raise HTTPException(status_code=504, detail="synthesis timed out")
    except asyncio.CancelledError:
        # The caller hung up (Starlette cancels the handler task) — same deal as
        # a timeout: a job still queued is skipped un-run instead of burning a
        # generation nobody will read. This is the "client disconnect" half of
        # the abandon contract engine.Job.abandoned documents.
        abandoned = getattr(job, "abandoned", None)
        if abandoned is not None:
            abandoned.set()
        raise
    except ShuttingDown:
        # The job was drained by a graceful shutdown — tell the caller to retry
        # elsewhere rather than logging it as an internal synthesis failure.
        raise HTTPException(status_code=503, detail="server shutting down")
    except Exception as exc:  # noqa: BLE001 - worker error -> sanitized 500
        # Never leak the raw worker exception to the client: log it server-side
        # against a short request id and hand the caller only that id.
        raise errors.sanitized_500("synthesis", exc)


async def _submit_and_wait(voice_id: str, text: str, overrides: dict,
                           frames_after_eos: int | None = None):
    """Submit one synthesis job and await its result (shared by the TTS,
    speak and performance endpoints). Raises the endpoint-shaped errors."""
    assert ENGINE is not None
    try:
        job = ENGINE.submit(voice_id=voice_id, text=text, overrides=overrides,
                            frames_after_eos=frames_after_eos)
    except AdmissionRejected as exc:
        raise _Backpressure(str(exc))
    return await _await_result(job)


def _abandon_all(jobs) -> None:
    """Mark every job in a batch abandoned so workers skip the un-started ones.

    Setting the flag on a job that already ran is a no-op (the worker only
    checks it before synthesis), so callers can sweep the whole batch.
    """
    for job in jobs:
        abandoned = getattr(job, "abandoned", None)
        if abandoned is not None:
            abandoned.set()


def _submit_batch(specs: list[tuple[str, str, dict]],
                  frames_after_eos: int | None = None) -> list:
    """Submit a whole batch up front (concurrency, not N× serial latency).

    Admission is decided here, so a mid-list rejection means the request fails
    with 429 — but the jobs already submitted must be ABANDONED rather than left
    to synthesize into a response that will never be sent.

    ``frames_after_eos`` applies to every job in the batch (the drop-in route
    carries one per request; /v1/speak and /v1/performance don't expose it).
    """
    jobs = []
    try:
        for voice_id, text, overrides in specs:
            jobs.append(ENGINE.submit(voice_id=voice_id, text=text,
                                      overrides=overrides,
                                      frames_after_eos=frames_after_eos))
    except AdmissionRejected:
        _abandon_all(jobs)
        raise
    return jobs


async def _gather_results(jobs: list):
    """Await a whole batch, abandoning every job if any of them fails.

    `asyncio.gather` cancels the sibling *coroutines* on the first exception,
    but the underlying worker futures keep running — without this the pool
    burns full generations for a response that already failed. The
    `BaseException` arm also covers `CancelledError`, i.e. the client hanging
    up mid-request. Always re-raises.
    """
    try:
        return await asyncio.gather(*(_await_result(job) for job in jobs))
    except BaseException:
        _abandon_all(jobs)
        raise


async def _offload(fn, *args):
    """Run blocking CPU/disk work off the event loop.

    The same treatment `resample_wav_bytes` and the mp3 encoder already get.
    Used for `concat_wavs` (N× wave parse + re-write, linear in script length)
    and `record_fallback` (JSON read + atomic rewrite per fallback segment) —
    both were running inline on the loop in the synthesis hot path, where a
    stall delays every one of the queued waiters.
    """
    return await asyncio.get_event_loop().run_in_executor(None, fn, *args)


class _Backpressure(Exception):
    """Queue full — translated to the 429 + Retry-After response."""


def _backpressure_response(exc: _Backpressure) -> JSONResponse:
    assert ENGINE is not None
    return JSONResponse(status_code=429,
                        content={"detail": str(exc), "queue": ENGINE.metrics.snapshot()},
                        headers={"Retry-After": "1"})


def _require_known_voice(voice_id: str) -> None:
    """A typo'd voice id must be the caller's 404, not a sanitized 500.

    Mirrors the worker's lookup order (engine._Worker._voice_state): exported
    embedding in the voices dir, a raw local file path (operator convenience),
    or a builtin name. Anything else would fall through to a model load whose
    exception surfaces as `synthesis failed (request <id>)` — and, uncached,
    every client retry would re-enter the model load.
    """
    if (Path(SETTINGS.voices_dir) / f"{voice_id}.safetensors").is_file():
        return
    if Path(voice_id).is_file():
        return
    if any(vid == voice_id for vid, _lang in BUILTIN):
        return
    raise HTTPException(status_code=404, detail=f"unknown voice '{voice_id}'")


def _voice_fingerprint(voice_id: str) -> str:
    """Identity of the BYTES behind a voice id: "{mtime_ns}:{size}".

    Re-cloning a Character rewrites its .safetensors under the SAME voice id,
    so without this a cached clip would outlive the voice that produced it and
    the new voice would serve the old audio. Builtin voices have no file (the
    weights are the model's own) and get a constant marker. Mirrors the lookup
    order of ``_require_known_voice`` / ``engine._Worker._voice_state``.
    """
    for cand in (Path(SETTINGS.voices_dir) / f"{voice_id}.safetensors",
                 Path(voice_id)):
        try:
            st = cand.stat()
        except (OSError, ValueError):  # missing, or not a usable path
            continue
        return f"{st.st_mtime_ns}:{st.st_size}"
    return "builtin"


def _cache_key(voice_id: str, text: str, overrides: dict,
               frames_after_eos: int | None) -> tuple:
    """Everything that can change the audio, and nothing that can't.

    Enumerated from the request surface:
      * ``voice_id`` — the RESOLVED voice (``_resolve_emotion_address`` has
        already turned "sarah:excited"/?emotion= into a concrete voice), never
        the pre-resolution address: two addresses that resolve to the same
        voice are the same audio, and one address that resolves differently
        (an emotion added since) must not collide.
      * ``_voice_fingerprint`` — the safetensors' mtime+size, so a re-cloned
        voice invalidates its cached audio.
      * ``text`` — verbatim (segmentation is derived from it).
      * ``overrides`` — temp / noise_clamp / lsd_decode_steps, i.e. every
        VoiceSettings field that reaches the model. similarity_boost and style
        are deliberately absent: they are inert (see VoiceSettings) and
        reported via X-Ignored-Settings, so they cannot change the audio.
      * ``frames_after_eos`` — the request's trailing-frames control.
      * ``max_tokens`` / ``language`` / ``quantize`` — process-wide generation
        and model identity; included so a config change can't serve audio
        rendered under the old one.
    ``model_id`` is not in the key: it is accepted for ElevenLabs
    compatibility and never reaches the engine. ``output_format`` is not in the
    key either — the cache stores native-rate WAV and every format is derived
    from it AFTER the lookup.
    """
    return (
        voice_id,
        _voice_fingerprint(voice_id),
        text,
        tuple(sorted(overrides.items())),
        frames_after_eos,
        SETTINGS.max_tokens,
        SETTINGS.language,
        SETTINGS.quantize,
    )


_CACHE_CONTROL_HEADER = "cache-control"
_CACHE_BYPASS_HEADER = "x-gravitone-cache"
_CACHE_BYPASS_VALUES = ("bypass", "no-store", "off")


def cache_bypass_requested(headers) -> bool:
    """Whether THIS request asked to skip the synthesis cache entirely.

    Why this exists: the cache is a real product win, but it also silently
    turns any repeated-identical-request measurement (the load-test harness,
    ``service.loadtest``) into a measurement of an LRU lookup. A benchmark must
    be able to say "render it, don't replay it" without the operator having to
    disable the cache service-wide (which would change what is being measured
    for every OTHER caller too).

    Two spellings, both honoured:
      * the standard ``Cache-Control: no-store`` / ``no-cache`` request header;
      * ``X-Gravitone-Cache: bypass`` (explicit, greppable in a har/proxy log).

    A bypassed request does no lookup, does not collapse onto another request's
    in-flight render, and does NOT store its result — so a benchmark corpus can
    never evict real callers' cached audio. It still passes through admission
    exactly like any other synthesis, so this is not a way around backpressure.
    ``headers`` may be any mapping (or None, for direct in-process calls).
    """
    if not headers:
        return False
    try:
        lowered = {str(k).lower(): str(v) for k, v in headers.items()}
    except Exception:  # noqa: BLE001 - an exotic mapping must not 500 a request
        return False
    if lowered.get(_CACHE_BYPASS_HEADER, "").strip().lower() in _CACHE_BYPASS_VALUES:
        return True
    cc = lowered.get(_CACHE_CONTROL_HEADER, "").lower()
    return "no-store" in cc or "no-cache" in cc


def _record_fallbacks(pairs: list[tuple[str, str]]) -> None:
    """Record a whole request's emotion fallbacks in ONE executor hop.

    Each `record_fallback` is a JSON read + atomic rewrite; doing them
    per-segment on the event loop meant a disk round-trip per fallback in the
    hot path. Batched here and offloaded by the callers via `_offload`.
    """
    for character_id, requested in pairs:
        record_fallback(character_id, requested)


async def _resolve_emotion_address(voice_id: str, emotion: str | None) -> tuple[str, dict[str, str]]:
    """Emotion-addressable voices — the Gravitone extension to the
    ElevenLabs-compatible endpoint.

    A caller may address `{character_id}:{emotion}` in the path (e.g.
    `sarah:excited`) or pass `?emotion=` with a character id. Emotions the
    Character lacks fall back to baseline, reported in response headers.
    Plain voice_ids pass through untouched.
    """
    if not emotion and ":" not in voice_id:
        _require_known_voice(voice_id)
        return voice_id, {}
    character_id, _, path_emotion = voice_id.partition(":")
    requested = (emotion or path_emotion).strip().lower()
    emap = emotion_map(character_id)
    if not emap:
        raise HTTPException(status_code=404, detail=f"unknown character '{character_id}'")
    resolved_id, used, fell_back = resolve(requested, emap)
    if fell_back:
        await _offload(_record_fallbacks, [(character_id, requested)])
    return resolved_id, {
        "X-Character": character_id,
        "X-Emotion-Requested": requested,
        "X-Emotion-Used": used,
        "X-Emotion-Fallback": "true" if fell_back else "false",
    }


_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?…])\s+")


def _split_sentences(text: str) -> list[str]:
    """Split free text into sentence-sized synthesis units for streaming.

    Deliberately simple (no metatag grammar — the streaming route mirrors the
    plain-text /v1/text-to-speech surface, not /v1/speak): break after
    sentence-final punctuation followed by whitespace. Text with no such
    punctuation stays a single unit.
    """
    text = (text or "").strip()
    if not text:
        return []
    parts = [p.strip() for p in _SENTENCE_SPLIT_RE.split(text)]
    parts = [p for p in parts if p]
    return parts or [text]


# Ceiling on the units ONE all-at-once batch may submit, whatever the queue
# depth is. Past this, more segments buy little parallelism (a single process
# has `workers` of them) while multiplying concat seams — and one caller should
# never be able to claim a huge admission window on its own.
_MAX_BATCH_UNITS = 16


def _max_batch_units() -> int:
    """How many units one BATCHED request may split into.

    The drop-in route submits every unit at once, so the unit count is an
    admission cost: the `workers + queue_max` window is shared with every other
    caller. Half of it, capped at ``_MAX_BATCH_UNITS``, leaves real headroom.
    Never below 1 — with a tiny configured queue this degrades to the original
    single-job request rather than turning long text into a certain 429.

    The streaming route does NOT pass a cap: it submits in a rolling window
    (see ``text_to_speech_stream``), so its unit count costs no admission and
    smaller units buy lower time-to-first-byte.
    """
    window = max(1, SETTINGS.workers + SETTINGS.queue_max)
    return max(1, min(_MAX_BATCH_UNITS, window // 2))


def _coalesce(parts: list[str], budget: int) -> list[str]:
    """Greedily merge neighbouring sentences up to ``budget`` characters."""
    chunks: list[str] = []
    cur = ""
    for part in parts:
        if not cur:
            cur = part
        elif len(cur) + 1 + len(part) <= budget:
            cur = f"{cur} {part}"
        else:
            chunks.append(cur)
            cur = part
    if cur:
        chunks.append(cur)
    return chunks


def _chunk_text(text: str, max_units: int | None = None) -> list[str]:
    """Split text into the synthesis UNITS a request is submitted as.

    Sentence-split (``_split_sentences``), then coalesce neighbours up to
    ``SETTINGS.chunk_chars`` so a unit is a natural prosodic span rather than a
    two-word fragment. Order is preserved; units re-join in this order.

    Text that fits the budget comes back as ONE unit — so a short request takes
    exactly the pre-segmentation code path, byte for byte.

    ``max_units`` is a HARD ceiling on the number of units, for callers that
    submit the whole batch at once and therefore pay admission per unit. The
    fixed budget alone does NOT bound the count: greedy packing only merges when
    the COMBINED length fits, so sentences longer than budget/2 never merge with
    a neighbour and the count degrades to one unit per sentence (~180-char
    sentences — ordinary prose — gave 44 units of an 8000-char body at a
    350-char budget). So when a cap is given the budget is DOUBLED until the
    count actually fits. It always terminates: a budget of len(text) merges
    everything into one unit. Starting from the configured budget (rather than
    jumping straight to a length-derived one) keeps units as fine as the cap
    allows, which is what parallelism wants — each doubling is one more linear
    pass over a list that is at most a few hundred sentences.

    Callers that submit incrementally (the streaming route) pass no cap and
    keep sentence-grained units.
    """
    parts = _split_sentences(text)
    if len(parts) <= 1:
        return parts
    budget = max(1, int(SETTINGS.chunk_chars))
    if max_units is None:
        return _coalesce(parts, budget)

    max_units = max(1, int(max_units))
    while True:
        chunks = _coalesce(parts, budget)
        if len(chunks) <= max_units:
            return chunks
        budget *= 2


# How long a stream waits before retrying a refused segment submission. Short
# enough to pick a freed slot up promptly, long enough not to spin the loop.
_ADMISSION_RETRY_S = 0.05


def _stream_window() -> int:
    """How many segments of one stream may sit in the engine at a time.

    Auto (``stream_window=0``) is ``workers + 1``: enough to keep every worker
    of this process fed with one in reserve, so the stream never stalls waiting
    for its own next segment, while the rest of the admission window stays
    available to other callers. Never below 2 — a window of 1 would serialise
    the stream and lose the concurrency the route exists for.
    """
    configured = int(SETTINGS.stream_window)
    if configured > 0:
        return max(2, configured)
    return max(2, SETTINGS.workers + 1)


def _wav_stream_header(sample_rate: int, channels: int = 1, bits: int = 16) -> bytes:
    """A 44-byte PCM WAV header for a stream of unknown total length.

    The RIFF/data sizes are set to the 32-bit max (streaming WAV convention):
    the client plays until the connection closes rather than trusting a length
    it cannot know up front. Byte-identical layout to what scipy writes, so a
    single header followed by raw PCM16 samples is a valid WAV.
    """
    byte_rate = sample_rate * channels * bits // 8
    block_align = channels * bits // 8
    return (
        b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVE"
        + b"fmt " + struct.pack("<IHHIIHH", 16, 1, channels, sample_rate,
                                byte_rate, block_align, bits)
        + b"data" + struct.pack("<I", 0xFFFFFFFF - 44)
    )


# ElevenLabs output_format grammar we honour. Native synthesis rate is 24000;
# any other rate is resampled (pcm/wav) or handed to ffmpeg -ar (mp3).
_MP3_RATES = (22050, 24000, 44100)
_MP3_BITRATES = (32, 64, 96, 128, 192)
_PCM_RATES = (8000, 16000, 22050, 24000, 44100, 48000)  # wav uses the same set
_NATIVE_RATE = 24000

_SUPPORTED_FORMATS_MSG = (
    "Supported output_format: "
    "mp3_{22050|24000|44100}_{32|64|96|128|192}, "
    "pcm_{8000|16000|22050|24000|44100|48000}, "
    "wav_{8000|16000|22050|24000|44100|48000} "
    "(bare 'mp3' | 'wav' | 'pcm' default to 24000; 'mp3' defaults to 128k)."
)


@dataclass
class _AudioFormat:
    kind: str          # wav | mp3 | pcm
    sample_rate: int   # requested output rate
    bitrate: int | None  # kbps, mp3 only
    content_type: str


def _bad_format(output_format: str) -> HTTPException:
    return HTTPException(
        status_code=400,
        detail=f"unsupported output_format {output_format!r}. " + _SUPPORTED_FORMATS_MSG)


def _parse_format(output_format: str) -> _AudioFormat:
    """Parse an ElevenLabs `output_format` into a validated _AudioFormat.

    Grammar: `mp3_{sr}_{bitrate}` | `pcm_{sr}` | `wav_{sr}`, plus the bare
    forms `mp3` | `pcm` | `wav`. Unsupported kinds, rates or bitrates raise a
    400 that lists exactly what IS supported (never a silent fallback to a rate
    the caller didn't ask for)."""
    fmt = (output_format or "wav_24000").lower().strip()
    parts = fmt.split("_")
    kind = parts[0]

    if kind == "mp3":
        if len(parts) == 1:
            sr, bitrate = _NATIVE_RATE, 128
        elif len(parts) == 3:
            try:
                sr, bitrate = int(parts[1]), int(parts[2])
            except ValueError:
                raise _bad_format(output_format)
            if sr not in _MP3_RATES or bitrate not in _MP3_BITRATES:
                raise _bad_format(output_format)
        else:
            raise _bad_format(output_format)
        return _AudioFormat("mp3", sr, bitrate, "audio/mpeg")

    if kind in ("pcm", "wav"):
        if len(parts) == 1:
            sr = _NATIVE_RATE
        elif len(parts) == 2:
            try:
                sr = int(parts[1])
            except ValueError:
                raise _bad_format(output_format)
            if sr not in _PCM_RATES:
                raise _bad_format(output_format)
        else:
            raise _bad_format(output_format)
        if kind == "pcm":
            return _AudioFormat("pcm", sr, None, "application/octet-stream")
        return _AudioFormat("wav", sr, None, "audio/wav")

    raise _bad_format(output_format)


@app.post("/v1/text-to-speech/{voice_id}", dependencies=[Depends(require_scope("tts"))])
async def text_to_speech(
    voice_id: str,
    req: TTSRequest,
    output_format: str = Query("wav_24000"),
    emotion: str | None = Query(None, description="Gravitone extension: address a Character's emotion voice (or use {character_id}:{emotion} as the path voice_id)"),
    request: Request = None,
):
    """Drop-in ElevenLabs synthesis.

    Long text is segmented (``_chunk_text``) and the units are submitted as ONE
    batch, so an N-unit body occupies up to N workers concurrently instead of
    serialising on a single worker — the same treatment /v1/speak and
    /v1/performance already get. The segments are re-joined with the engine's
    ``concat_wavs`` (the identical path /v1/speak uses, so seams behave the
    same). Text that fits ``SETTINGS.chunk_chars`` stays ONE unit and takes the
    original single-job path unchanged, bytes and headers included, and the
    unit count is capped at ``_max_batch_units()`` so a long body can never
    submit more jobs than the admission window has room for.

    Results are cached per process (``SYNTH_CACHE``) on the full request
    identity, and concurrent identical requests collapse onto one synthesis.
    Every response says which it was via ``X-Cache: hit|miss|bypass``; on a hit
    the timing headers report the REAL (near-zero) serve cost, never a replay of
    what the original render cost — and ``X-Realtime-Factor`` is ``n/a``,
    because a cache lookup is not a measurement of the model (a hit's
    audio/serve-time ratio is a number in the millions and means nothing).
    ``Cache-Control: no-store`` / ``X-Gravitone-Cache: bypass`` renders from
    scratch without reading or writing the cache — that is how the benchmark
    harness measures synthesis (see ``cache_bypass_requested``).
    """
    assert ENGINE is not None
    fmt = _parse_format(output_format)  # 400s early on an unsupported format
    voice_id, emotion_headers = await _resolve_emotion_address(voice_id, emotion)

    overrides = _overrides(req.voice_settings)
    extra_headers: dict[str, str] = {}
    timing: dict[str, float] = {}
    t_request = time.perf_counter()

    async def _synthesize() -> CachedAudio:
        """Render this request from scratch, recording its true timings."""
        # Batched submission: the unit count is capped, because every unit
        # takes an admission slot at the same instant (_max_batch_units).
        units = _chunk_text(req.text, max_units=_max_batch_units())
        if len(units) <= 1:
            # Single unit: identical to the pre-segmentation behaviour,
            # including the timing headers (X-Synth-Seconds stays the job's own
            # synthesis time, which for one job IS the request's synthesis
            # wall-clock minus the queue wait already in X-Queue-Seconds).
            result = await _submit_and_wait(voice_id, req.text, overrides,
                                            frames_after_eos=req.frames_after_eos)
            timing["synth"] = result.synth_seconds
            timing["queue"] = result.queue_seconds
            return CachedAudio(wav_bytes=result.wav_bytes,
                               sample_rate=result.sample_rate,
                               audio_seconds=result.audio_seconds, segments=1)

        t_start = time.perf_counter()
        try:
            jobs = _submit_batch([(voice_id, unit, overrides) for unit in units],
                                 frames_after_eos=req.frames_after_eos)
        except AdmissionRejected as exc:
            # Admission is decided for the whole batch; _submit_batch already
            # abandoned the siblings that did get in.
            raise _Backpressure(str(exc))
        results = await _gather_results(jobs)
        wav_bytes = await _offload(concat_wavs, [r.wav_bytes for r in results])
        # Wall-clock for the WHOLE request, not the sum of per-segment synth
        # times: the segments ran concurrently, so summing them would report a
        # duration that never elapsed (and a realtime factor that never was).
        timing["synth"] = round(time.perf_counter() - t_start, 3)
        timing["queue"] = round(max(r.queue_seconds for r in results), 3)
        return CachedAudio(
            wav_bytes=wav_bytes, sample_rate=results[0].sample_rate,
            audio_seconds=round(sum(r.audio_seconds for r in results), 3),
            segments=len(units))

    bypass = cache_bypass_requested(request.headers if request is not None else None)
    key = _cache_key(voice_id, req.text, overrides, req.frames_after_eos)
    try:
        if bypass:
            # No lookup, no single-flight collapse, no store: this request is
            # rendered by the model or it fails. The benchmark depends on it.
            SYNTH_CACHE.note_bypass()
            audio, was_cached = await _synthesize(), False
        else:
            audio, was_cached = await SYNTH_CACHE.get_or_synthesize(key, _synthesize)
    except _Backpressure as exc:
        # Backpressure: tell the client to retry — the queue cap was hit.
        return _backpressure_response(exc)

    if was_cached:
        # The truth, not a replayed number: what this request actually spent.
        synth_seconds = round(time.perf_counter() - t_request, 6)
        queue_seconds = 0.0
    else:
        synth_seconds = timing["synth"]
        queue_seconds = timing["queue"]
    extra_headers["X-Cache"] = "bypass" if bypass else ("hit" if was_cached else "miss")
    if audio.segments > 1:
        extra_headers["X-Synth-Segments"] = str(audio.segments)

    wav_bytes = audio.wav_bytes
    native_rate = audio.sample_rate
    audio_seconds = audio.audio_seconds

    loop = asyncio.get_event_loop()
    if fmt.kind == "mp3":
        # Honour the requested bitrate and (via ffmpeg -ar) sample rate.
        bitrate = f"{fmt.bitrate}k"
        ar = fmt.sample_rate if fmt.sample_rate != native_rate else None
        body = await loop.run_in_executor(
            None, lambda: wav_bytes_to_mp3(wav_bytes, bitrate=bitrate, sample_rate=ar))
    elif fmt.kind == "pcm":
        wav = wav_bytes
        if fmt.sample_rate != native_rate:
            wav = await loop.run_in_executor(
                None, resample_wav_bytes, wav, fmt.sample_rate)
        # strip the 44-byte WAV header -> raw PCM16
        body = wav[44:]
        extra_headers["X-Sample-Rate"] = str(fmt.sample_rate)
    else:  # wav
        body = wav_bytes
        if fmt.sample_rate != native_rate:
            body = await loop.run_in_executor(
                None, resample_wav_bytes, body, fmt.sample_rate)

    return Response(
        content=body, media_type=fmt.content_type,
        headers={
            "X-Audio-Seconds": str(audio_seconds),
            "X-Synth-Seconds": str(synth_seconds),
            "X-Queue-Seconds": str(queue_seconds),
            # A realtime factor is a claim about the MODEL. A cache hit ran no
            # model, so audio/serve-time (audio ÷ ~1e-6 s → millions) would be a
            # fabricated number that a benchmark would happily average and a
            # certificate would happily sign. Say "n/a" instead: X-Synth-Seconds
            # still reports this request's true serve cost, and X-Cache says why.
            "X-Realtime-Factor": "n/a" if was_cached else (
                str(round(audio_seconds / synth_seconds, 3))
                if synth_seconds else "n/a"),
            **extra_headers,
            **emotion_headers,
            **_ignored_headers(req.voice_settings),
        },
    )


@app.post("/v1/text-to-speech/{voice_id}/stream",
          dependencies=[Depends(require_scope("tts"))])
async def text_to_speech_stream(
    voice_id: str,
    req: TTSRequest,
    output_format: str = Query("wav_24000"),
    emotion: str | None = Query(None, description="Gravitone extension: address a Character's emotion voice (or use {character_id}:{emotion} as the path voice_id)"),
):
    """Low-latency streaming synthesis (ElevenLabs' headline feature).

    The text is segmented (``_chunk_text``) and submitted to the worker pool in
    a bounded ROLLING WINDOW: the first window is submitted before the response
    starts (so admission — the 429 backpressure decision — happens BEFORE any
    bytes are streamed, never mid-stream) and each further segment is submitted
    as an earlier one is consumed. Audio streams back IN ORDER as each segment
    finishes; because the window keeps several segments in flight, the first
    chunk leaves before the last segment is done — latency to first byte drops
    from full-synthesis time to first-segment time.

    Script length therefore no longer decides admission. Submitting every
    sentence up front meant any script longer than the admission window
    (workers + queue_max, 33 by default) was rejected with 429 before a byte
    streamed — the failure scaled exactly with the input people demo with.

    Formats: `pcm_*` streams raw PCM16 chunks; `wav_*` streams a single
    streaming WAV header then raw PCM16 samples; `mp3_*` returns 501 (MP3 needs
    the whole clip to transcode, which defeats streaming — use the non-stream
    route for MP3).

    Timing headers: the per-synthesis timing headers of the non-stream route
    (X-Synth-Seconds, X-Realtime-Factor, …) are intentionally ABSENT here —
    HTTP response headers are flushed before synthesis completes, so those
    numbers cannot be known when the headers go out. Only pre-stream headers
    (X-Stream, X-Stream-Segments, emotion resolution) are emitted.

    A genuinely saturated engine still rejects the request with 429 up front
    (the first window can't be admitted) rather than truncating mid-stream. The
    whole response is bounded by ONE deadline (``stream_deadline_s``); when it
    expires the stream ends and every un-consumed segment is abandoned.
    """
    assert ENGINE is not None
    fmt = _parse_format(output_format)  # 400s early on an unsupported format
    if fmt.kind == "mp3":
        raise HTTPException(
            status_code=501,
            detail="mp3 is not supported on the streaming endpoint (transcoding "
                   "needs the complete clip); use output_format=pcm_24000 or "
                   "wav_24000 to stream, or the non-streaming route for mp3",
        )
    voice_id, emotion_headers = await _resolve_emotion_address(voice_id, emotion)

    chunks = _chunk_text(req.text)
    overrides = _overrides(req.voice_settings)
    window = min(len(chunks), _stream_window())

    # Submit the FIRST WINDOW up front: this decides admission (429) before we
    # commit to a streaming response, keeping backpressure semantics identical
    # to the non-stream route. Workers pick the window up concurrently; the
    # rest is submitted as segments are consumed.
    try:
        submitted = _submit_batch([(voice_id, text, overrides)
                                   for text in chunks[:window]],
                                  frames_after_eos=req.frames_after_eos)
    except AdmissionRejected as exc:
        return _backpressure_response(_Backpressure(str(exc)))

    pending = deque(chunks[window:])
    total = len(chunks)
    loop = asyncio.get_event_loop()

    async def _audio_stream():
        header_sent = False
        consumed = 0
        deadline = time.monotonic() + SETTINGS.stream_deadline_s
        try:
            while True:
                # Keep the rolling window full. A refusal here is NOT the
                # caller's 429 (the status is long gone) — it just means the
                # engine is busy, so we retry after the next segment.
                while pending and (len(submitted) - consumed) < window:
                    try:
                        submitted.append(ENGINE.submit(
                            voice_id=voice_id, text=pending[0],
                            overrides=overrides,
                            frames_after_eos=req.frames_after_eos))
                    except AdmissionRejected:
                        break
                    except ShuttingDown:
                        logger.info("stream stopped submitting at segment "
                                    "%d/%d: server shutting down",
                                    len(submitted) + 1, total)
                        pending.clear()
                        break
                    pending.popleft()

                if consumed >= len(submitted):
                    if not pending:
                        return  # whole script delivered
                    # Nothing of ours is in flight and the engine is full of
                    # someone else's work: wait for a slot, bounded by the one
                    # whole-request deadline.
                    if time.monotonic() >= deadline:
                        logger.error("stream deadline (%ss) exceeded waiting "
                                     "for admission at segment %d/%d; "
                                     "truncating stream",
                                     SETTINGS.stream_deadline_s, consumed + 1,
                                     total)
                        return
                    await asyncio.sleep(_ADMISSION_RETRY_S)
                    continue

                job = submitted[consumed]
                remaining = deadline - time.monotonic()
                try:
                    if remaining <= 0:
                        raise asyncio.TimeoutError
                    result = await asyncio.wait_for(
                        asyncio.wrap_future(job.future), timeout=remaining)
                except asyncio.TimeoutError:
                    # ONE deadline for the whole response, not one per segment.
                    # Status is already sent; the only client signal left is
                    # closing the stream (short clip / reset connection).
                    if ENGINE is not None:
                        ENGINE.metrics.on_timeout()
                    logger.error("stream deadline (%ss) exceeded at segment "
                                 "%d/%d; truncating stream",
                                 SETTINGS.stream_deadline_s, consumed + 1, total)
                    return
                except ShuttingDown:
                    logger.info("stream truncated by graceful shutdown at "
                                "segment %d/%d", consumed + 1, total)
                    return
                except Exception as exc:  # noqa: BLE001 - status already sent
                    request_id = uuid.uuid4().hex[:8]
                    logger.error("stream segment %d/%d failed [request %s]: %s",
                                 consumed + 1, total, request_id, exc,
                                 exc_info=True)
                    return
                consumed += 1
                native_rate = result.sample_rate
                # Honour a pcm_{sr}/wav_{sr} suffix: resample each segment before
                # yielding so the stream carries the rate the caller asked for.
                if fmt.sample_rate != native_rate:
                    wav = await loop.run_in_executor(
                        None, resample_wav_bytes, result.wav_bytes, fmt.sample_rate)
                else:
                    wav = result.wav_bytes
                samples = wav[44:]  # strip the per-segment WAV header
                if fmt.kind == "wav" and not header_sent:
                    yield _wav_stream_header(fmt.sample_rate)
                    header_sent = True
                yield samples
        finally:
            # Stream over early (deadline, segment error, or the client hung up
            # — GeneratorExit lands here): whatever is still queued will never
            # be read, so mark it abandoned and let the workers skip it un-run.
            _abandon_all(submitted[consumed:])

    stream_headers = {
        "X-Stream": "true",
        "X-Stream-Segments": str(total),
        **emotion_headers,
        **_ignored_headers(req.voice_settings),
    }
    if fmt.kind == "pcm":
        stream_headers["X-Sample-Rate"] = str(fmt.sample_rate)

    return StreamingResponse(
        _audio_stream(), media_type=fmt.content_type,
        headers=stream_headers,
    )


# Voice + Character management lives in service/voices.py. Read endpoints
# (list voices/characters/emotions) accept a tts-scoped key so ElevenLabs
# drop-in clients work; mutations need the "voices" scope.
app.include_router(voices_router, dependencies=[Depends(require_read_write("tts", "voices"))])
# API key management (issue / rotate / revoke) — root TTS_API_KEY only.
app.include_router(keys_router, dependencies=[Depends(require_scope("admin"))])
# Character ingestion (scan a recording → review → commit) — "clone" scope.
app.include_router(ingest_router, dependencies=[Depends(require_scope("clone"))])
# Character Packs (export/import portable bundles) — exporting hands out the
# raw voice embeddings, so both directions need the "voices" scope.
app.include_router(packs_router, dependencies=[Depends(require_scope("voices"))])
# Shared takes (public Voice Cards) — reads/writes ride the web proxy's key;
# direct API access needs a tts-scoped key.
app.include_router(takes_router, dependencies=[Depends(require_scope("tts"))])
# Review sets (client approval links) — same surface, same scope.
app.include_router(reviews_router, dependencies=[Depends(require_scope("tts"))])


class SpeakRequest(BaseModel):
    character_id: str
    text: str = Field(..., min_length=1, max_length=8000)
    voice_settings: VoiceSettings | None = None


@app.post("/v1/speak", dependencies=[Depends(require_scope("tts"))])
async def speak(
    req: SpeakRequest,
):
    """Speak metatagged text with one Character, switching Voices per emotion.

        "Hello. [excited]This is amazing![/excited] [sad]But now I'm sad."

    Emotions the Character lacks fall back to its baseline Voice. The per-segment
    report (what was requested vs what was used) is returned base64-JSON in the
    `X-Segments` header so the UI can show the substitutions.
    """
    assert ENGINE is not None

    emap = emotion_map(req.character_id)
    if not emap:
        raise HTTPException(status_code=404, detail=f"unknown character '{req.character_id}'")

    segments = parse_segments(req.text)
    overrides = _overrides(req.voice_settings)

    # Resolve every segment's voice, then submit them ALL before awaiting any:
    # the pool processes them concurrently (up to WORKERS at once) instead of
    # paying N× latency serially. Admission (429) is decided at submit time; if
    # any segment is rejected the whole request fails with 429 and the segments
    # already submitted are abandoned (see _submit_batch) rather than burning
    # worker slots for a response that will never be sent.
    resolved: list[tuple] = []
    fallbacks: list[tuple[str, str]] = []
    for seg in segments:
        voice_id, used, fell_back = resolve(seg.emotion, emap)
        if fell_back:
            fallbacks.append((req.character_id, seg.emotion))
        resolved.append((seg, voice_id, used, fell_back))
    if fallbacks:  # one executor hop, not one disk write per segment
        await _offload(_record_fallbacks, fallbacks)

    try:
        jobs = _submit_batch([(voice_id, seg.text, overrides)
                              for (seg, voice_id, used, fell_back) in resolved])
    except AdmissionRejected as exc:
        return _backpressure_response(_Backpressure(str(exc)))

    results = await _gather_results(jobs)

    wavs: list[bytes] = []
    report: list[dict] = []
    total_audio = 0.0
    total_synth = 0.0
    for (seg, voice_id, used, fell_back), result in zip(resolved, results):
        wavs.append(result.wav_bytes)
        total_audio += result.audio_seconds
        total_synth += result.synth_seconds
        report.append({
            "text": seg.text, "requested": seg.emotion, "used": used,
            "fallback": fell_back, "voice_id": voice_id, "seconds": result.audio_seconds,
        })

    body = await _offload(concat_wavs, wavs)
    rtf = round(total_audio / total_synth, 3) if total_synth else 0.0
    return Response(
        content=body, media_type="audio/wav",
        headers={
            "X-Audio-Seconds": str(round(total_audio, 2)),
            "X-Synth-Seconds": str(round(total_synth, 3)),
            "X-Realtime-Factor": str(rtf),
            "X-Segments": base64.b64encode(json.dumps(report).encode()).decode(),
            **_ignored_headers(req.voice_settings),
        },
    )


class PerformanceLine(BaseModel):
    """One directed line: a Character speaking (optionally metatagged) text."""
    character_id: str
    text: str = Field(..., min_length=1, max_length=8000)
    voice_settings: VoiceSettings | None = None


class PerformanceRequest(BaseModel):
    lines: list[PerformanceLine] = Field(..., min_length=1, max_length=64)


@app.post("/v1/performance", dependencies=[Depends(require_scope("performance"))])
async def performance(req: PerformanceRequest):
    """Character Performance API — a multi-character script in one call.

    Each line names a Character; its text may use the same emotion metatags
    as /v1/speak ("[excited]...[/excited]"). Voices switch per character AND
    per emotion, missing emotions fall back to baseline, and the full
    line/segment substitution report comes back base64-JSON in
    X-Performance-Report. Premium surface: requires the "performance" key
    scope (the root key always passes).
    """
    assert ENGINE is not None

    ignored = sorted({s for line in req.lines for s in _ignored_settings(line.voice_settings)},
                     key=["similarity_boost", "style"].index)

    # Fail fast: validate every character before synthesizing anything.
    emaps: dict[str, dict[str, str]] = {}
    for i, line in enumerate(req.lines):
        if line.character_id not in emaps:
            emap = emotion_map(line.character_id)
            if not emap:
                raise HTTPException(status_code=404,
                                    detail=f"unknown character '{line.character_id}' (line {i})")
            emaps[line.character_id] = emap

    # Flatten every line into its emotion segments, resolving voices first,
    # then submit them ALL concurrently and gather in order — an N-segment
    # script occupies up to WORKERS at once instead of serialising. A rejected
    # segment fails the whole request with 429 (see /v1/speak for the rationale).
    tasks: list[tuple] = []  # (line_idx, character_id, seg, voice_id, used, fell_back)
    fallbacks: list[tuple[str, str]] = []
    for i, line in enumerate(req.lines):
        emap = emaps[line.character_id]
        overrides = _overrides(line.voice_settings)
        for seg in parse_segments(line.text):
            voice_id, used, fell_back = resolve(seg.emotion, emap)
            if fell_back:
                fallbacks.append((line.character_id, seg.emotion))
            tasks.append((i, line.character_id, seg, voice_id, used, fell_back, overrides))
    if fallbacks:  # one executor hop, not one disk write per segment
        await _offload(_record_fallbacks, fallbacks)

    try:
        jobs = _submit_batch([(t[3], t[2].text, t[6]) for t in tasks])
    except AdmissionRejected as exc:
        return _backpressure_response(_Backpressure(str(exc)))

    results = await _gather_results(jobs)

    wavs: list[bytes] = []
    report: list[dict] = []
    total_audio = 0.0
    total_synth = 0.0
    for (i, character_id, seg, voice_id, used, fell_back, _overr), result in zip(tasks, results):
        wavs.append(result.wav_bytes)
        total_audio += result.audio_seconds
        total_synth += result.synth_seconds
        report.append({
            "line": i, "character_id": character_id, "text": seg.text,
            "requested": seg.emotion, "used": used, "fallback": fell_back,
            "voice_id": voice_id, "seconds": result.audio_seconds,
        })

    body = await _offload(concat_wavs, wavs)
    rtf = round(total_audio / total_synth, 3) if total_synth else 0.0
    return Response(
        content=body, media_type="audio/wav",
        headers={
            "X-Audio-Seconds": str(round(total_audio, 2)),
            "X-Synth-Seconds": str(round(total_synth, 3)),
            "X-Realtime-Factor": str(rtf),
            "X-Performance-Report": base64.b64encode(json.dumps(report).encode()).decode(),
            **({"X-Ignored-Settings": ",".join(ignored)} if ignored else {}),
        },
    )


@app.get("/health")
async def health():
    if ENGINE is None or not ENGINE.ready:
        return JSONResponse(status_code=503, content={"status": "loading"})
    if ENGINE.draining:
        # Readiness must fail the moment the drain starts, or the load balancer
        # keeps routing new work to a pod that answers every submit with 503.
        # Liveness is a TCP probe, so failing here removes us from the
        # Endpoints list without getting killed mid-drain.
        return JSONResponse(status_code=503, content={"status": "draining"})
    return {"status": "ready", "config": ENGINE.config(), "metrics": ENGINE.metrics.snapshot()}


@app.get("/metrics")
async def metrics():
    if ENGINE is None:
        raise HTTPException(status_code=503, detail="engine not ready")
    # `cache` is this PROCESS's synthesis cache (per replica, never global).
    return {"config": ENGINE.config(), "metrics": ENGINE.metrics.snapshot(),
            "cache": SYNTH_CACHE.stats()}


def main():
    import uvicorn
    uvicorn.run(app, host=SETTINGS.host, port=SETTINGS.port, log_level="info")


if __name__ == "__main__":
    main()
