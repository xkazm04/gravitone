"""ElevenLabs-shaped HTTP API in front of the Pocket TTS worker pool.

Endpoints (compatible with common ElevenLabs client code):
  POST /v1/text-to-speech/{voice_id}          -> audio bytes (wav|mp3)
  POST /v1/speech-to-text                     -> transcript (service/stt.py)
  GET  /v1/voices                             -> list available voices
  WS   /v1/convai/conversation                -> a spoken conversation, shaped
                                                 like ElevenLabs Agents
                                                 (service/convai.py)
  GET  /health                                -> readiness (config/metrics for
                                                 observability-scope callers)
  GET  /metrics                               -> raw counters for the load test
                                                 (scoped; loopback exempt)

Request body mirrors ElevenLabs:
  { "text": "...", "model_id": "pocket_tts",
    "voice_settings": { "temperature": 0.7 } }
`output_format` is a query param (elevenlabs-style): wav_24000 | mp3_24000_128 | pcm_24000.
The same grammar is honoured by the Gravitone routes /v1/speak and
/v1/performance (one parser, `_parse_format`; one renderer, `_encode_audio`).
Auth: enforced when TTS_API_KEY is set (see service/auth.py) — the root key or
a managed `/v1/keys` key via `xi-api-key` / `Authorization: Bearer`.

Browser clients: CORS is CLOSED until an operator names their origins in
`TTS_CORS_ORIGINS` (see `cors_policy` below and Settings' CORS block). With
nothing set, cross-origin browser calls fail at the preflight exactly as they
did before — server-to-server clients and the studio's server-side proxy are
unaffected. Once set, the custom response headers (`X-Cache`,
`X-Realtime-Factor`, ...) are exposed so the client can actually read them.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import struct
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

import base64
import json

from service.auth import authorize_headers, optional_scope, require_read_write, require_scope
from service import buildstore
from service import errors
from service import stt, verify
from service.cache import CachedAudio, SynthCache
from service.config import SETTINGS
from service.demand import record_fallback
from service.emotions import parse_segments, resolve
from service.engine import (
    AdmissionRejected, ShuttingDown, TtsEngine, concat_wavs,
    resample_pcm16, resample_wav_bytes, wav_bytes_to_mp3,
)
from service.voices import BUILTIN, emotion_map, prosody_map, router as voices_router
from service.keys import router as keys_router
from service import ingest_api
from service.ingest_api import (
    router as ingest_router, start_background as ingest_start_background,
    stop_background as ingest_stop_background,
)
from service.packs import router as packs_router
from service.direction import router as direction_router
from service.narrate import router as narrate_router
from service.takes import router as takes_router, reviews_router
from service import takes as takes_plane
from service.ratelimit import per_ip_budget
from service import convai
from service.appliance import router as appliance_router
from service.convai import router as convai_router, ws_router as convai_ws_router
from service import engines as engines_plane
from service.engines import router as engines_router
from service.gym import router as gym_router
from service.stt import router as stt_router
from service import observability

# Error reporting, before anything else in this module runs and before the app
# object exists — the Starlette/FastAPI integrations patch the middleware stack,
# so an init that came later would only half-apply.
#
# This is a NO-OP without SENTRY_DSN, and a strict one: with the variable unset
# `sentry_sdk` is never imported, so nothing is patched, no transport exists and
# nothing is transmitted. See service/observability.py for the full posture.
observability.init()

ENGINE: TtsEngine | None = None

# Finished audio, keyed on full request identity (_cache_key). PER PROCESS: the
# service runs as N single-worker replicas, so a hit here is a hit for this
# replica only. See service/cache.py.
SYNTH_CACHE = SynthCache(SETTINGS.cache_bytes)

# Word/character alignments, cached BESIDE the audio: same key discipline
# (``_alignment_key`` = the audio's identity plus the route that produced it),
# same single-flight collapse, its own byte budget. A separate instance rather
# than a second entry SHAPE inside SYNTH_CACHE because service/cache.py states
# the invariant plainly — "stored in separate cache instances and never mix in
# one keyspace" — and an alignment is not audio. The budget follows the audio
# cache's on/off: with synthesis caching disabled, nothing is remembered here
# either. Alignments are small (a few KB of times per clip), so a sixteenth of
# the audio budget holds far more of them than the audio cache holds clips.
ALIGN_CACHE: SynthCache = SynthCache(SETTINGS.cache_bytes // 16)

# Finished ARTIFACTS, on disk, addressed by their public digest. Where
# SYNTH_CACHE is this process's memory of what it just rendered, this is the
# durable, shareable half: it survives a restart, it is visible to every replica
# pointed at the same directory, and its keys are the names clients hold
# (X-Speech-Digest / a lockfile). See service/buildstore.py.
BUILD_STORE = buildstore.STORE

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
    #
    # INGEST DRAINS TOO, and first. It used not to drain at all: the lifespan
    # stopped ENGINE while ingest's phase threads were daemons nobody joined,
    # so a SIGTERM mid-commit killed a clone with rows already registered and
    # its rollback still ahead of it. Ingest's phases do not use ENGINE (they
    # spawn their own one-load export child), so draining them first costs the
    # engine nothing and gives a commit its grace while the box is still up.
    # A phase that outruns the grace is reconciled from its journal at the next
    # startup (ingest_api._reconcile) — the grace is the optimization, that is
    # the guarantee.
    await asyncio.get_event_loop().run_in_executor(
        None, ingest_stop_background, ingest_api.DRAIN_GRACE_S)
    await asyncio.get_event_loop().run_in_executor(
        None, ENGINE.stop, SETTINGS.drain_timeout_s)


def docs_urls(settings=SETTINGS) -> dict:
    """`docs_url`/`redoc_url`/`openapi_url` kwargs for this configuration.

    FastAPI's defaults publish /docs, /redoc and /openapi.json to anyone. On a
    key-protected deployment that is the complete interactive catalogue of
    every route — /v1/keys included — served to unauthenticated visitors, so
    the default policy ("auto") turns all three OFF the moment TTS_API_KEY is
    set and leaves them ON for open local dev, where they are the point.
    See Settings.docs for the "on"/"off" overrides.
    """
    mode = (settings.docs or "auto").strip().lower()
    published = mode == "on" or (mode != "off" and not settings.api_key)
    if published:
        return {"docs_url": "/docs", "redoc_url": "/redoc",
                "openapi_url": "/openapi.json"}
    return {"docs_url": None, "redoc_url": None, "openapi_url": None}


app = FastAPI(title="Pocket TTS Service", version="1.0.0", lifespan=lifespan,
              **docs_urls())

# Unhandled exceptions keep the {"detail"} JSON contract (sanitized request-id
# body) instead of escaping to Starlette's plain-text page.
errors.install_catch_all(app)

# --- Browser access ---------------------------------------------------------
# Headers a browser client is MEANT to read. Without expose_headers the fetch
# response object hides every one of them even on a successful cross-origin
# request, which silently breaks the cache/latency/fallback signals the API
# publishes (X-Cache, X-Realtime-Factor, X-Emotion-Fallback, ...) and the
# backoff hint on a 429 (Retry-After).
CORS_EXPOSE_HEADERS = [
    "ETag", "Retry-After",
    "X-Alignment-Cache",
    "X-Audio-Seconds", "X-Cache", "X-Character", "X-Emotion-Fallback",
    "X-Emotion-Requested", "X-Emotion-Used", "X-Fidelity-Deltas",
    "X-Fidelity-Retries", "X-Fidelity-Score", "X-Fidelity-Unavailable",
    "X-Gravitone-Cache", "X-Gravitone-Deadline",
    "X-Ignored-Settings", "X-Performance-Report", "X-Quality-Level",
    "X-Queue-Seconds",
    "X-Realtime-Factor", "X-Sample-Rate", "X-Segments", "X-Speech-Digest",
    "X-Stream", "X-Stream-Fallback", "X-Stream-Segments",
    "X-Synth-Seconds", "X-Synth-Segments",
]
# What the API actually accepts. Named explicitly rather than "*": the
# allow-list IS the policy, and a browser's preflight asks about exactly these.
CORS_ALLOW_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PATCH", "DELETE"]
CORS_ALLOW_HEADERS = ["xi-api-key", "Authorization", "Content-Type", "Accept"]


def cors_policy(settings=SETTINGS) -> dict | None:
    """The CORSMiddleware kwargs for this configuration, or None for CLOSED.

    Closed is the default and the fail-safe: with no TTS_CORS_ORIGINS and no
    regex there is no middleware at all, so the service behaves exactly as it
    did before this existed (server-to-server and the studio's server-side
    proxy work; browsers get no cross-origin access to a box that also mounts
    /v1/keys and /v1/ingest).
    """
    origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
    regex = settings.cors_origin_regex.strip()
    if not origins and not regex:
        return None
    credentials = settings.cors_allow_credentials
    if "*" in origins:
        logger.warning(
            "CORS: TTS_CORS_ORIGINS is '*' — every origin on the internet may "
            "call this service from a browser. Name your origins instead.")
        if credentials:
            # The CORS spec forbids the pair; honouring both would make every
            # browser reject the response anyway. Drop the weaker guarantee.
            logger.warning("CORS: allow_credentials ignored — invalid with '*'")
            credentials = False
    return {
        "allow_origins": origins,
        "allow_origin_regex": regex or None,
        "allow_credentials": credentials,
        "allow_methods": CORS_ALLOW_METHODS,
        "allow_headers": CORS_ALLOW_HEADERS,
        "expose_headers": CORS_EXPOSE_HEADERS,
        "max_age": settings.cors_max_age,
    }


_CORS = cors_policy()
if _CORS is not None:
    app.add_middleware(CORSMiddleware, **_CORS)
    logger.info("CORS enabled for origins=%s regex=%s",
                _CORS["allow_origins"] or "-", _CORS["allow_origin_regex"] or "-")


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

        `use_speaker_boost` and `speed` are the rest of the current EL
        VoiceSettings contract and are inert for the same reason: there is no
        speaker-boost stage in this pipeline, and pocket-tts has no rate control
        (resampling would change the pitch, which is not what `speed` means).
        They are DECLARED here rather than left to pydantic's extra-ignore
        because a field the model does not know about is dropped SILENTLY — and
        a silent drop is the one thing this header exists to prevent.
    """
    # 0.5 (consistent) .. 1.0 (expressive). Model default 0.7.
    temperature: float | None = None
    # 0 (off) .. 1 (tight). Mapped to the model's `noise_clamp`.
    stability: float | None = None
    # 1 (fast) .. 5 (best). Mapped to `lsd_decode_steps`; costs realtime factor.
    quality: int | None = None
    # Accepted for ElevenLabs compatibility; inert (see class docstring). A
    # request that sets any of these is reported via X-Ignored-Settings.
    similarity_boost: float | None = None
    style: float | None = None
    use_speaker_boost: bool | None = None
    speed: float | None = None


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


# VoiceSettings fields that reach nothing. Ordered, so the header is stable.
_INERT_VOICE_SETTINGS = ("similarity_boost", "style", "use_speaker_boost", "speed")


def _ignored_settings(vs: VoiceSettings | None) -> list[str]:
    """ElevenLabs VoiceSettings fields we accept but cannot honestly honour.

    Returns the names actually present on this request (so the header only
    appears when a client really sent one), preserving a stable order."""
    if vs is None:
        return []
    return [name for name in _INERT_VOICE_SETTINGS
            if getattr(vs, name, None) is not None]


def _ignored_request_fields(req: "TTSRequest | None") -> list[str]:
    """Top-level ElevenLabs request fields we accept but do not act on.

    Same contract as `_ignored_settings`, one level up. These are reported by
    `model_fields_set` — "the client actually sent it" — rather than by value,
    because several of them (`use_pvc_as_ivc: false`,
    `apply_language_text_normalization: false`) have a meaningful default that
    is indistinguishable from absence if you only look at the value.
    """
    if req is None:
        return []
    sent = req.model_fields_set
    return [name for name in _INERT_REQUEST_FIELDS if name in sent]


def _ignored_headers(vs: VoiceSettings | None,
                     req: "TTSRequest | None" = None) -> dict[str, str]:
    """{'X-Ignored-Settings': 'similarity_boost,seed'} or {} if none ignored.

    ONE header for both levels of the request: a client debugging "why did my
    parameter do nothing" should not have to know whether the parameter it sent
    lived in `voice_settings` or at the top level. `req` is optional because the
    Gravitone-native routes (/v1/speak, /v1/performance) have their own body
    models, which never carried the EL top-level fields.
    """
    names = _ignored_settings(vs) + _ignored_request_fields(req)
    return {"X-Ignored-Settings": ",".join(names)} if names else {}


# Top-level ElevenLabs request-body fields that reach nothing here. Declared on
# TTSRequest (below) so they are ACKNOWLEDGED rather than silently dropped by
# pydantic's extra-ignore, and reported on X-Ignored-Settings. Ordered.
#
# Why each is inert, so nobody "fixes" one by wiring it to the nearest knob:
#   seed                              - pocket-tts exposes no sampler seed, so
#                                       there is nothing to make deterministic.
#                                       (Repeatability IS available, by a
#                                       different mechanism: X-Speech-Digest /
#                                       If-None-Match return the same bytes.)
#   language_code                     - one English model; see GET /v1/models.
#   previous_text / next_text         - no cross-request prosody conditioning.
#   previous_request_ids /
#     next_request_ids                - same, by request id.
#   pronunciation_dictionary_locators - no pronunciation dictionaries.
#   apply_text_normalization /
#     apply_language_text_normalization - normalization here is fixed, not a
#                                       per-request switch.
#   use_pvc_as_ivc                    - no PVC/IVC distinction in our voices.
_INERT_REQUEST_FIELDS = (
    "seed", "language_code", "previous_text", "next_text",
    "previous_request_ids", "next_request_ids",
    "pronunciation_dictionary_locators", "apply_text_normalization",
    "apply_language_text_normalization", "use_pvc_as_ivc",
)


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=8000)
    model_id: str | None = "pocket_tts"
    voice_settings: VoiceSettings | None = None
    frames_after_eos: int | None = None
    # --- ElevenLabs drop-in: accepted, typed, and inert (see
    # _INERT_REQUEST_FIELDS). Typed loosely on purpose: the point is that an
    # unmodified EL client never gets a 422 for sending its own contract, so a
    # field whose exact EL type drifts must not become a validation failure
    # here. Nothing downstream reads them.
    seed: int | None = None
    language_code: str | None = None
    previous_text: str | None = None
    next_text: str | None = None
    previous_request_ids: list[str] | None = None
    next_request_ids: list[str] | None = None
    pronunciation_dictionary_locators: list[dict] | None = None
    apply_text_normalization: str | None = None
    apply_language_text_normalization: bool | None = None
    use_pvc_as_ivc: bool | None = None
    # The deadline contract. Absent = the previous behaviour exactly: bulk
    # class, arrival order, full quality. degrade_allowed is opt-in because a
    # cheaper render nobody asked for is silent quality loss.
    deadline_s: float | None = Field(None, gt=0, le=3600)
    degrade_allowed: bool = False


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


# The smallest deadline this layer will ever hand the engine. A request whose
# horizon has already elapsed (a later wave, a later stream segment) must still
# say "I am out of time" rather than silently reverting to NO deadline, which is
# what passing None would mean — and the engine's own class floor
# (engine._deadline_floor_s) is what stops that number buying unfair priority.
_SPENT_DEADLINE_S = 0.001


def _contract_kwargs(deadline_s: float | None, degrade_allowed: bool = False,
                     job_class: str | None = None,
                     elapsed_s: float = 0.0) -> dict:
    """Engine kwargs for the deadline contract — the ONE place they are built.

    Only passes what the caller actually used: engine doubles in the test suite
    predate these parameters, and a request that named no deadline must reach
    ``submit()`` as the exact call it always made (this is what keeps "no
    deadline named" byte-identical to the pre-deadline service).

    ``elapsed_s`` is how much of the caller's horizon this request has ALREADY
    spent before this particular submission — the later waves of /v1/speak and
    the later segments of the streaming route. ``deadline_s`` is defined as
    "seconds from admission", so re-sending the caller's original number on a
    submission made ten seconds later would silently extend their deadline by
    ten seconds. What is handed over is the REMAINING horizon.
    """
    extra: dict = {}
    if deadline_s is not None:
        extra["deadline_s"] = max(_SPENT_DEADLINE_S,
                                  float(deadline_s) - max(0.0, elapsed_s))
    if job_class is not None:
        extra["job_class"] = job_class
    if degrade_allowed:
        extra["degrade_allowed"] = degrade_allowed
    return extra


def _batch_promise(jobs: list) -> dict:
    """The promise/quality a MULTI-JOB request may report, from its jobs.

    The units of one request run concurrently, so the request is done when its
    LAST unit is: the promise is the largest per-unit promise, and it is
    withheld entirely (None) if any unit was not promised — a partial promise
    covering some of the audio is not a promise about the response.

    Quality is reported as the WORST level any unit ran at, because that is the
    level the caller can hear.
    """
    promises = [getattr(j, "promised_s", None) for j in jobs]
    levels = [getattr(j, "quality_level", "full") for j in jobs]
    order = ["full", "reduced", "minimal"]
    worst = max(levels, key=lambda lv: order.index(lv) if lv in order else 0,
                default="full")
    return {"deadline": (max(promises) if promises and all(p is not None
                                                           for p in promises)
                         else None),
            "quality": worst}


def _promise_headers(promise: dict) -> dict[str, str]:
    """X-Gravitone-Deadline / X-Quality-Level for a promise dict, or {}.

    Visible, never silent: a caller who allowed degradation is TOLD which level
    ran, and a promise is only ever sent when the engine was willing to make one
    (a warm window, and a calibrated basis — see engine.TtsEngine.submit).
    """
    headers: dict[str, str] = {}
    if promise.get("deadline") is not None:
        headers["X-Gravitone-Deadline"] = str(promise["deadline"])
    if promise.get("quality") not in (None, "full"):
        headers["X-Quality-Level"] = str(promise["quality"])
    return headers


async def _submit_and_wait(voice_id: str, text: str, overrides: dict,
                           frames_after_eos: int | None = None,
                           deadline_s: float | None = None,
                           job_class: str | None = None,
                           degrade_allowed: bool = False,
                           promise: dict | None = None):
    """Submit one synthesis job and await its result (shared by the TTS,
    speak and performance endpoints). Raises the endpoint-shaped errors.

    ``promise`` is an out-parameter: the caller passes a dict and gets back the
    engine's numeric promise and the quality level actually used, which become
    X-Gravitone-Deadline / X-Quality-Level. Returning it would change this
    function's return type at ~6 call sites for a header two of them want.
    """
    assert ENGINE is not None
    extra = _contract_kwargs(deadline_s, degrade_allowed, job_class=job_class)
    try:
        job = ENGINE.submit(voice_id=voice_id, text=text, overrides=overrides,
                            frames_after_eos=frames_after_eos, **extra)
    except AdmissionRejected as exc:
        raise _Backpressure(str(exc), exc)
    if promise is not None:
        # None promised_s = a cold window: send NO header rather than a guess.
        promise["deadline"] = getattr(job, "promised_s", None)
        promise["quality"] = getattr(job, "quality_level", "full")
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
                  frames_after_eos: int | None = None,
                  deadline_s: float | None = None,
                  degrade_allowed: bool = False,
                  elapsed_s: float = 0.0) -> list:
    """Submit a whole batch up front (concurrency, not N× serial latency).

    Admission is decided here, so a mid-list rejection means the request fails
    with 429 — but the jobs already submitted must be ABANDONED rather than left
    to synthesize into a response that will never be sent.

    ``frames_after_eos`` applies to every job in the batch (the drop-in route
    carries one per request; /v1/speak and /v1/performance don't expose it).

    THE MULTI-UNIT DEADLINE SEMANTIC: every unit inherits the WHOLE request's
    horizon — the same ``deadline_s``, not a 1/N slice of it. A multi-unit
    request is one response, and that response is complete only when its LAST
    unit is; the units are submitted at the same instant and run concurrently
    (the batch is capped at ``_max_batch_units()``, this process's real
    parallelism), so each unit's own horizon IS the request's horizon. Slicing
    the deadline N ways would be arithmetically tidier and operationally wrong:
    it would make each unit look far more urgent than the request really is,
    escalating a segmented request past an identical unsegmented one purely
    because its text was longer. ``elapsed_s`` covers the one case where the
    horizon really has shrunk — a batch submitted LATER than the request's
    admission (a second wave, a later stream window) — see ``_contract_kwargs``.
    """
    extra = _contract_kwargs(deadline_s, degrade_allowed, elapsed_s=elapsed_s)
    jobs = []
    try:
        for voice_id, text, overrides in specs:
            jobs.append(ENGINE.submit(voice_id=voice_id, text=text,
                                      overrides=overrides,
                                      frames_after_eos=frames_after_eos,
                                      **extra))
    except AdmissionRejected:
        _abandon_all(jobs)
        raise
    return jobs


async def _submit_and_gather_in_waves(specs: list[tuple[str, str, dict]],
                                      deadline_s: float | None = None,
                                      degrade_allowed: bool = False,
                                      promise: dict | None = None) -> list:
    """Submit a multi-segment script as WAVES, returning results in spec order.

    ``/v1/speak`` and ``/v1/performance`` flatten their input into one job per
    emotion segment — a 64-line ensemble script easily becomes hundreds — and
    submitted every one of them at the same instant against an admission window
    of ``workers + queue_max`` (33 by default). Past that the request 429'd
    itself: the failure scaled with exactly the input the premium routes exist
    to showcase.

    The bound is ``_max_batch_units()``, the SAME policy the drop-in route uses
    — derived from the parallelism this process actually HAS
    (``SETTINGS.workers``), never from queue depth. Two different answers to
    "how many units may one request submit" would be worse than one wrong one.

    Where the drop-in route differs is what it does when the input exceeds the
    cap: its units are slices of ONE text, so ``_chunk_text`` MERGES them.
    Segments here cannot merge — each names the voice that speaks it, and
    merging would change WHICH voice says WHICH words — so the script is
    submitted in successive waves of at most the cap instead. Order is
    untouched: waves go in order, each wave gathers in order, and a script that
    already fit is exactly one wave, i.e. the previous call sequence byte for
    byte.

    Admission still fails the WHOLE request: an ``AdmissionRejected`` anywhere
    propagates to the caller's 429, and ``_submit_batch`` has already abandoned
    that wave's siblings. Waves that already completed are not undone — they are
    finished audio, not a burning worker slot — which is the same trade the
    streaming route's rolling window makes.

    The deadline contract rides along: every segment of a wave inherits the
    request's horizon (see ``_submit_batch``), but a wave submitted after
    earlier waves have already run gets the REMAINING horizon, because waves are
    sequential in time and ``deadline_s`` means "seconds from admission". A
    request whose horizon is spent by wave three still names a (spent) deadline
    rather than reverting to none — that is the truth, and the engine records
    the miss instead of pretending the request became deadline-free.

    ``promise`` is the same out-parameter ``_submit_and_wait`` takes: the
    promise and quality level of ALL jobs across ALL waves (``_batch_promise``).
    """
    cap = max(1, _max_batch_units())
    results: list = []
    submitted: list = []
    t_start = time.monotonic()
    for i in range(0, len(specs), cap):
        jobs = _submit_batch(specs[i:i + cap], deadline_s=deadline_s,
                             degrade_allowed=degrade_allowed,
                             elapsed_s=time.monotonic() - t_start)
        submitted.extend(jobs)
        results.extend(await _gather_results(jobs))
    if promise is not None:
        promise.update(_batch_promise(submitted))
    return results


def _pack_waves(weights: list[int], cap: int) -> list[list[int]]:
    """Group item indices into waves whose total UNIT count stays inside ``cap``.

    The sibling of ``_submit_and_gather_in_waves`` for a caller whose items are
    not bare specs but whole renders (``/v1/build``: one ``_render_tts`` per
    manifest line, each of which may itself segment into several units). Same
    budget, ``_max_batch_units()``, because "how many units may one request
    submit at one instant" must have ONE answer whether the units came from one
    long body or from four lines of a script — the alternative is a manifest
    submitting ``cap`` lines × ``cap`` units and 429ing itself on exactly the
    input the route exists for.

    Order-preserving and greedy: waves go in item order, and an item heavier
    than the cap gets a wave to itself rather than being split or dropped.
    """
    waves: list[list[int]] = []
    current: list[int] = []
    load = 0
    for i, weight in enumerate(weights):
        weight = max(1, int(weight))
        if current and load + weight > cap:
            waves.append(current)
            current, load = [], 0
        current.append(i)
        load += weight
    if current:
        waves.append(current)
    return waves


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
    """Queue full — translated to the 429 + Retry-After response.

    Carries the engine's AdmissionRejected when there is one, so the 429 can
    report the predicted wait instead of an unconditional "Retry-After: 1".
    """

    def __init__(self, message: str, rejection: AdmissionRejected | None = None):
        super().__init__(message)
        self.rejection = rejection


def _backpressure_response(exc: _Backpressure) -> JSONResponse:
    assert ENGINE is not None
    # `counters()`, NOT `snapshot()`: this response is minted exactly when the
    # box is saturated, and snapshot sorts the latency/synth windows to compute
    # percentiles — work on the event loop that no rejected caller reads. The
    # queue depth, in-flight count and rejection tally are what make a 429
    # actionable, and they are O(1).
    rejection = getattr(exc, "rejection", None)
    admission = rejection.payload() if rejection is not None else {}
    retry_after = admission.get("retry_after_s") or 1
    return JSONResponse(
        status_code=429,
        content={"detail": str(exc), "queue": ENGINE.metrics.counters(),
                 # The truth about the refusal: how long this caller would have
                 # waited, and when it is worth coming back.
                 "admission": admission},
        headers={"Retry-After": str(int(retry_after))})


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
    resolved_id, used, fell_back = resolve(requested, emap, prosody=prosody_map(character_id))
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


# Hard ceiling on the units ONE all-at-once batch may submit, however many
# workers a process is configured with. Past this the concat seams and per-unit
# model setup/teardown grow while one caller claims an ever larger share of the
# admission window everybody else is queueing in.
_MAX_BATCH_UNITS = 16


def _max_batch_units() -> int:
    """How many units one BATCHED request may split into.

    Derived from the parallelism this process actually HAS — ``SETTINGS.workers``
    independent model instances — and NOT from the admission window. The drop-in
    route submits every unit at the same instant, so a unit beyond the worker
    count does not start any sooner: it queues behind its own siblings and runs
    serially anyway, while still costing an admission slot, a concat seam and a
    per-unit model setup/teardown. Same total model work, strictly more
    overhead. (``workers + queue_max`` is a QUEUE-DEPTH knob; deriving the cap
    from it also meant raising ``queue_max`` for backpressure headroom silently
    raised how much of it one caller could claim.)

    On the topology this product SHIPS that means 1. ``workers`` defaults to 1
    (config.py: generation is GIL/serialization-bound, so the recommendation is
    to scale by PROCESS) and ``replicas.py`` hard-pins ``TTS_WORKERS=1`` into
    every replica it spawns. A single-worker replica cannot run two units at
    once, so the honest batch size is one and a long body takes the plain
    single-job path. Batching is untouched and still correct for an operator who
    really does run ``TTS_WORKERS=N``: there it splits into at most N units that
    genuinely occupy N workers.

    Still bounded by ``_MAX_BATCH_UNITS`` and by half the ``workers +
    queue_max`` window, so a large in-process pool cannot let one caller take
    the admission window away from everybody else.

    The streaming route does NOT pass a cap: it submits in a rolling window (see
    ``text_to_speech_stream``), so its unit count costs no admission — and its
    win is time-to-first-byte, which a single worker delivers just as well
    (first-segment time instead of whole-body time).
    """
    parallel = max(1, int(SETTINGS.workers))
    if parallel == 1:
        return 1
    window = max(1, SETTINGS.workers + SETTINGS.queue_max)
    return max(1, min(_MAX_BATCH_UNITS, parallel, window // 2))


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

    ``max_units=1`` means "there is no parallelism to split for" (the shipped
    single-worker replica, see ``_max_batch_units``) and short-circuits: the
    body comes back as the un-segmented text itself, so the caller takes the
    original single-job path byte for byte instead of paying a widen loop to
    re-derive it.

    Callers that submit incrementally (the streaming route) pass no cap and
    keep sentence-grained units.
    """
    parts = _split_sentences(text)
    if len(parts) <= 1:
        return parts
    if max_units is not None and int(max_units) <= 1:
        return [text.strip()]
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


async def _encode_audio(fmt: _AudioFormat, wav_bytes: bytes,
                        native_rate: int) -> tuple[bytes, dict[str, str]]:
    """Render native-rate WAV bytes as ``fmt``; returns (body, extra headers).

    The OUTPUT half of the format grammar, in one place, for every
    non-streaming synthesis route (``/v1/text-to-speech``, ``/v1/speak``,
    ``/v1/performance``) — ``_parse_format`` validates, this renders. Two copies
    of this branch would be two answers to "what does pcm_16000 mean".

    ``fmt.sample_rate == native_rate`` returns the WAV bytes UNCHANGED, so the
    default ``wav_24000`` is byte-identical to no conversion at all.

    Every transcode/resample goes through the executor: these are ``async def``
    handlers, and mp3 encoding (an ffmpeg subprocess) or a resample on the event
    loop stalls every other request in the process (repo law; guarded by
    service/tests/test_handler_modes.py).
    """
    loop = asyncio.get_event_loop()
    headers: dict[str, str] = {}
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
        headers["X-Sample-Rate"] = str(fmt.sample_rate)
    else:  # wav
        body = wav_bytes
        if fmt.sample_rate != native_rate:
            body = await loop.run_in_executor(
                None, resample_wav_bytes, body, fmt.sample_rate)
    return body, headers


@dataclass
class _Rendered:
    """One finished synthesis, before it is turned into a response.

    The shared result of the drop-in route and its ``/with-timestamps`` twin:
    the two must never be two synthesis paths (that is how "the same request
    returns different audio depending on which URL you used" happens), so the
    rendering, the cache lookup and the timing truth live here exactly once and
    each route decides only how to SHAPE it.
    """
    audio: CachedAudio
    key: tuple
    was_cached: bool
    bypass: bool
    synth_seconds: float
    queue_seconds: float
    extra_headers: dict
    emotion_headers: dict

    def timing_headers(self) -> dict[str, str]:
        return {
            "X-Audio-Seconds": str(self.audio.audio_seconds),
            "X-Synth-Seconds": str(self.synth_seconds),
            "X-Queue-Seconds": str(self.queue_seconds),
            # A realtime factor is a claim about the MODEL. A cache hit ran no
            # model, so audio/serve-time (audio ÷ ~1e-6 s → millions) would be a
            # fabricated number that a benchmark would happily average and a
            # certificate would happily sign. Say "n/a" instead: X-Synth-Seconds
            # still reports this request's true serve cost, and X-Cache says why.
            "X-Realtime-Factor": "n/a" if self.was_cached else (
                str(round(self.audio.audio_seconds / self.synth_seconds, 3))
                if self.synth_seconds else "n/a"),
        }


async def _render_tts(voice_id: str, req: TTSRequest, emotion: str | None,
                      request: Request | None,
                      resolved: tuple[str, dict] | None = None,
                      ) -> "_Rendered | JSONResponse":
    """Synthesize (or serve from cache) one drop-in TTS request.

    Pure code motion out of ``text_to_speech``: same segmentation, same cache
    identity, same metrics accounting, same truthful timings. Returns the 429
    JSONResponse directly when admission refuses, because backpressure is a
    RESPONSE, not an exception the callers should each re-derive.

    ``resolved`` lets a caller that has ALREADY resolved the emotion address
    (because it needed the concrete voice id to compute the request's digest
    before deciding whether to synthesize at all) hand the answer in. Resolving
    twice would not merely be wasted work: ``_resolve_emotion_address`` records a
    fallback to disk, so the same request would be counted twice in the emotion
    demand ledger.
    """
    assert ENGINE is not None
    if resolved is None:
        resolved = await _resolve_emotion_address(voice_id, emotion)
    voice_id, emotion_headers = resolved

    overrides = _overrides(req.voice_settings)
    extra_headers: dict[str, str] = {}
    timing: dict[str, float] = {}
    t_request = time.perf_counter()

    async def _synthesize() -> CachedAudio:
        """Render this request from scratch, recording its true timings."""
        # Batched submission: the unit count is capped at the parallelism this
        # process actually has, because every unit takes an admission slot at
        # the same instant (_max_batch_units). At the shipped workers=1 the cap
        # is 1 and this returns a single unit — the branch below.
        units = _chunk_text(req.text, max_units=_max_batch_units())
        if len(units) <= 1:
            # Single unit: identical to the pre-segmentation behaviour,
            # including the timing headers (X-Synth-Seconds stays the job's own
            # synthesis time, which for one job IS the request's synthesis
            # wall-clock minus the queue wait already in X-Queue-Seconds).
            promise: dict = {}
            result = await _submit_and_wait(
                voice_id, req.text, overrides,
                frames_after_eos=req.frames_after_eos,
                deadline_s=req.deadline_s,
                degrade_allowed=req.degrade_allowed,
                promise=promise)
            extra_headers.update(_promise_headers(promise))
            timing["synth"] = result.synth_seconds
            timing["queue"] = result.queue_seconds
            return CachedAudio(wav_bytes=result.wav_bytes,
                               sample_rate=result.sample_rate,
                               audio_seconds=result.audio_seconds, segments=1)

        t_start = time.perf_counter()
        try:
            # Same contract as the single-unit branch above: the caller's
            # deadline reaches the engine whichever branch their text length
            # happens to take (it used to reach it from the single-unit branch
            # ONLY, so a deadline was honoured or ignored by text length).
            # Every unit inherits the request's horizon — see _submit_batch.
            jobs = _submit_batch([(voice_id, unit, overrides) for unit in units],
                                 frames_after_eos=req.frames_after_eos,
                                 deadline_s=req.deadline_s,
                                 degrade_allowed=req.degrade_allowed)
        except AdmissionRejected as exc:
            # Admission is decided for the whole batch; _submit_batch already
            # abandoned the siblings that did get in.
            raise _Backpressure(str(exc), exc)
        extra_headers.update(_promise_headers(_batch_promise(jobs)))
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
    # `received` is "requests this replica served". A cache-served request never
    # reaches ENGINE.submit (which is the only other place that bumps it), so
    # without these calls the counter silently stopped counting them and every
    # ratio derived from it — and `cache_hits`/`collapsed` in /metrics and in
    # replicas.AGG_KEYS — was structurally zero.
    hits_before, collapsed_before = SYNTH_CACHE.hits, SYNTH_CACHE.collapsed
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
        # Which KIND of cache serve this was: a stored hit, or a collapse onto
        # another request's in-flight render. The cache reports the two
        # separately, so classify by which of its counters this call moved.
        # (Two identical requests resolving inside the same await window can
        # swap the labels between themselves; the SUM — and `received`, the
        # number this exists to correct — is exact either way.)
        if SYNTH_CACHE.hits > hits_before:
            ENGINE.metrics.on_cache_hit()
        elif SYNTH_CACHE.collapsed > collapsed_before:
            ENGINE.metrics.on_collapsed()
        else:  # pragma: no cover - defensive: served, so it counts as received
            ENGINE.metrics.on_cache_hit()
        # The truth, not a replayed number: what this request actually spent.
        synth_seconds = round(time.perf_counter() - t_request, 6)
        queue_seconds = 0.0
    else:
        synth_seconds = timing["synth"]
        queue_seconds = timing["queue"]
    extra_headers["X-Cache"] = "bypass" if bypass else ("hit" if was_cached else "miss")
    if audio.segments > 1:
        extra_headers["X-Synth-Segments"] = str(audio.segments)

    return _Rendered(audio=audio, key=key, was_cached=was_cached, bypass=bypass,
                     synth_seconds=synth_seconds, queue_seconds=queue_seconds,
                     extra_headers=extra_headers,
                     emotion_headers=emotion_headers)


# ---------------------------------------------------------------------------
# Speech as a build artifact — the public identity of a render
# ---------------------------------------------------------------------------
# The identity function itself lives in service/buildstore.py (with the DIGEST
# LAW it must be maintained under); what belongs HERE is the part only this
# module knows: which engine config a render happened under, and how this
# process segments text. Both are folded into the digest, so a replica
# configured differently cannot hand out the same NAME for different bytes.

def _engine_version() -> str:
    """Model/engine identity plus the process-wide generation config.

    ``MODEL_VERSION`` covers the weights (bump it when they change — DIGEST
    LAW); the rest are the ``SETTINGS`` values that reach every generation and
    genuinely change the audio, exactly the ones ``_cache_key`` already folds in.
    Read from SETTINGS at call time so a test that rebinds them is honoured.
    """
    return (f"{buildstore.MODEL_VERSION}"
            f"/lang={SETTINGS.language}/quant={int(bool(SETTINGS.quantize))}"
            f"/max_tokens={SETTINGS.max_tokens}")


def _segmentation_version() -> str:
    """How this process cuts text into synthesis units.

    ``SEGMENTATION_VERSION`` names the ALGORITHM (bump it when ``_chunk_text``
    or the concat discipline changes); ``chunk_chars`` and the batch cap are the
    two inputs that decide where the seams actually land on this box. Seams are
    audible, so they are part of the artifact's identity rather than an
    implementation detail hidden behind the name.
    """
    return (f"{buildstore.SEGMENTATION_VERSION}"
            f"/chunk={SETTINGS.chunk_chars}/units={_max_batch_units()}")


class _RequestIdentity:
    """The parts of a speech digest that are constant across ONE request.

    ``_engine_version``/``_segmentation_version`` rebuild an f-string out of
    SETTINGS, and ``_voice_fingerprint`` stats a ``.safetensors`` — none of
    which is a property of the LINE being named. A single-line route pays that
    once and never notices; ``/v1/build`` names up to
    ``BUILD_MANIFEST_MAX_LINES`` lines per request and was paying all of it per
    line, including the stat calls, on the event loop.

    So the constants are computed ONCE per request and memoized here, and the
    fingerprint is memoized per voice id (a cast of five speaking three hundred
    lines is five stats, not six hundred). Built at REQUEST time, never at
    import: a test that rebinds ``SETTINGS`` before a call must still be
    honoured, which is the property ``_engine_version``'s docstring names.

    The digest INPUTS are byte-for-byte what ``buildstore.speech_digest``
    always received — this is a memo, not a new identity. Anything that could
    change within one request (the voice's bytes being rewritten mid-manifest)
    is exactly what a request-scoped memo is allowed to miss: the manifest is
    named under the voice it started with, consistently for every line.
    """

    __slots__ = ("engine_version", "segmentation", "_fingerprints")

    def __init__(self) -> None:
        self.engine_version = _engine_version()
        self.segmentation = _segmentation_version()
        self._fingerprints: dict[str, str] = {}

    def fingerprint(self, voice_id: str) -> str:
        fp = self._fingerprints.get(voice_id)
        if fp is None:
            fp = self._fingerprints[voice_id] = _voice_fingerprint(voice_id)
        return fp

    def digest(self, voice_id: str, text: str, overrides: dict,
               frames_after_eos: int | None, output_format: str) -> str:
        return buildstore.speech_digest(
            voice_id=voice_id,
            voice_fingerprint=self.fingerprint(voice_id),
            text=text,
            overrides=overrides,
            frames_after_eos=frames_after_eos,
            output_format=output_format,
            engine_version=self.engine_version,
            segmentation=self.segmentation,
        )


def _speech_digest(voice_id: str, text: str, overrides: dict,
                   frames_after_eos: int | None, output_format: str) -> str:
    """``sha256:<hex>`` for a RESOLVED (voice, text, settings, format) request.

    One function, every route: the drop-in route and a ``/v1/build`` line with
    identical inputs MUST produce the same string, because that identity is the
    entire product claim — a lockfile written by a build is what an ordinary
    synthesis call answers to. Naming ONE clip; a route naming a whole manifest
    holds a ``_RequestIdentity`` instead, which is this call with its constants
    hoisted out of the loop.
    """
    return _RequestIdentity().digest(voice_id, text, overrides,
                                     frames_after_eos, output_format)


def _digest_headers(digest: str) -> dict[str, str]:
    """The two ways a client can hold onto a digest.

    ``X-Speech-Digest`` is the product-facing name (it goes in a lockfile);
    ``ETag`` is the same value in the shape HTTP already knows how to
    revalidate, so ``If-None-Match`` works with a plain HTTP cache and with
    ``curl -H`` alike.
    """
    return {"X-Speech-Digest": digest, "ETag": f'"{digest}"'}


async def _store_artifact(digest: str, body: bytes, fmt: _AudioFormat,
                          audio: CachedAudio) -> None:
    """Put a finished artifact in the durable store. Never fails a request.

    Off the event loop (disk + a cross-process lock). A store that is disabled,
    full or unwritable is a non-event for the caller: the audio it asked for is
    already in the response, and ``buildstore`` logs the reason.
    """
    await _offload(lambda: BUILD_STORE.put(
        digest, body, content_type=fmt.content_type,
        audio_seconds=audio.audio_seconds, sample_rate=fmt.sample_rate))


# Hero-demo hardening: the unauthenticated relay path (/api/tts -> here,
# /api/voices -> the clone route) gets a per-IP budget. Tighten once
# TTS_TRUST_PROXY is on and the studio is not one address for every visitor.
#
# EVERY compute route carries one, not just the drop-in: /v1/speak and
# /v1/performance spend the same worker permits and the same CPU seconds, and a
# budget that covers one of three entrances is decoration. All of them are
# env-tunable because the right number is a property of the deployment, not of
# the code, and all of them are sized for the SHIPPED shape of the traffic: the
# studio relays server-side with the deployment's own key, so every studio
# visitor arrives as ONE address (the proxy host) until TTS_TRUST_PROXY is on.
# A limit that would be generous per human is therefore a limit for the whole
# room, and these are set accordingly — high enough that a live demo with a
# dozen people at it never sees a 429, low enough that a scripted client cannot
# hold the queue.
def _budget_limit(env: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(env, "") or default))
    except ValueError:
        return default


DEMO_TTS_BUDGET = per_ip_budget(
    "demo-tts", limit=_budget_limit("TTS_BUDGET_TTS", 60), window_s=60, burst=6)
DEMO_CLONE_BUDGET = per_ip_budget(
    "demo-clone", limit=_budget_limit("TTS_BUDGET_CLONE", 20), window_s=600,
    burst=4, methods=("POST",))
# /v1/speak is the studio's own render path (metatagged multi-segment lines):
# a working session is a handful of renders a minute per person, so 120/60s is
# roughly a dozen people rendering steadily, and the burst of 12 is what a
# "render all lines" click legitimately looks like.
SPEAK_BUDGET = per_ip_budget(
    "speak", limit=_budget_limit("TTS_BUDGET_SPEAK", 120), window_s=60, burst=12)
# /v1/performance renders a whole cast against a script — the single most
# expensive request this service takes. Fewer, slower, and it is deliberately
# not something a room full of demo visitors should be running at once.
PERFORMANCE_BUDGET = per_ip_budget(
    "performance", limit=_budget_limit("TTS_BUDGET_PERFORMANCE", 30),
    window_s=60, burst=5)


@app.post("/v1/text-to-speech/{voice_id}",
          dependencies=[Depends(require_scope("tts")), Depends(DEMO_TTS_BUDGET)])
async def text_to_speech(
    voice_id: str,
    req: TTSRequest,
    output_format: str = Query("wav_24000"),
    emotion: str | None = Query(None, description="Gravitone extension: address a Character's emotion voice (or use {character_id}:{emotion} as the path voice_id)"),
    # Annotated (not `= Query(...)`) so the DEFAULT is a real None: the cache
    # and parallelism suites call this handler directly, in process, where
    # nothing resolves a Query object into a value.
    verify_mode: Annotated[str | None, Query(
        alias="verify",
        description="Opt-in verification: true (score the audio against the "
                    "text) or strict (also re-render once when it scores "
                    "badly)")] = None,
    request: Request = None,
):
    """Drop-in ElevenLabs synthesis.

    Long text is segmented (``_chunk_text``) only as far as this process can
    actually run in parallel. The units are submitted as ONE batch, so a unit
    beyond ``SETTINGS.workers`` would not occupy another worker — it would queue
    behind its own siblings — and ``_max_batch_units()`` caps the count at the
    real worker count for exactly that reason.

    On the SHIPPED single-worker replica (``workers`` defaults to 1 and
    ``replicas.py`` pins ``TTS_WORKERS=1``) that cap is 1, so EVERY body, long
    or short, takes the plain single-job path — no batch, no concat seams, no
    multi-slot admission cost, bytes and headers exactly as before segmentation
    existed. With ``TTS_WORKERS=N`` a long body splits into at most N units that
    do run concurrently and are re-joined with the engine's own ``concat_wavs``
    (the identical path /v1/speak uses, so seams behave the same); that request
    reports ``X-Synth-Segments``.

    Long text on a single worker is not slower than it was — it is the same one
    job it always was. For lower latency on long text whatever the worker count,
    use ``/stream``: its rolling window drops time-to-first-byte to
    first-segment time with one worker just as well as with N.

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

    Every response carries ``X-Speech-Digest: sha256:…`` (and the same value as
    an ``ETag``): the PUBLIC name of this piece of speech, computed from the
    inputs alone — resolved voice + its weights' fingerprint, normalized text,
    settings, frames_after_eos, engine/model version, output format and
    segmentation (see service/buildstore.py and its DIGEST LAW). Send it back as
    ``If-None-Match`` and an unchanged request answers ``304`` without
    synthesizing anything at all. The artifact is also written to the durable
    content-addressed store, so the same digest is fetchable from
    ``GET /v1/audio/{digest}`` after a restart and a ``POST /v1/build`` line with
    identical inputs reports the SAME digest.

    ``?verify=true`` (opt-in, off by default) additionally listens to the
    finished audio with the local ASR and reports what it heard as
    ``X-Fidelity-Score`` + ``X-Fidelity-Deltas``; ``?verify=strict`` may
    re-render ONCE when the score is bad (``X-Fidelity-Retries``). Without the
    parameter this route does not touch the transcriber, costs exactly what it
    always did, and returns byte-identical bytes and headers — verification
    roughly doubles the CPU of a request, so it can never be the default.
    """
    assert ENGINE is not None
    fmt = _parse_format(output_format)  # 400s early on an unsupported format
    mode = _verify_mode(verify_mode)    # 400s early on an unknown verify value

    # Identity BEFORE synthesis: a digest is over the inputs, so it is knowable
    # without a worker — which is exactly what makes If-None-Match cheap.
    resolved = await _resolve_emotion_address(voice_id, emotion)
    digest = _speech_digest(resolved[0], req.text, _overrides(req.voice_settings),
                            req.frames_after_eos, output_format)
    digest_headers = _digest_headers(digest)
    if buildstore.etag_matches(
            request.headers.get("if-none-match") if request is not None else None,
            digest):
        # The caller already holds these exact bytes. Answering 304 here costs
        # no synthesis at all: nothing was rendered, no admission slot was
        # taken, and the response carries no body by definition.
        return Response(status_code=304, headers={**digest_headers,
                                                  **resolved[1]})

    rendered = await _render_tts(voice_id, req, emotion, request,
                                 resolved=resolved)
    if isinstance(rendered, JSONResponse):
        return rendered  # backpressure

    verify_headers: dict[str, str] = {}
    if mode != "off":
        rendered, verify_headers = await _verify_rendered(rendered, voice_id,
                                                          req, mode)

    body, format_headers = await _encode_audio(fmt, rendered.audio.wav_bytes,
                                               rendered.audio.sample_rate)
    extra_headers = dict(rendered.extra_headers)
    extra_headers.update(format_headers)

    # Publish the artifact under its public name — unless this request opted out
    # of caching (`Cache-Control: no-store` covers the durable copy too) or
    # `verify=strict` may have served a RE-RENDER: a retry exists because the
    # first render was wrong, and storing a coin-flip under a stable name is
    # exactly the lie the DIGEST LAW exists to prevent.
    if not rendered.bypass and mode != "strict":
        await _store_artifact(digest, body, fmt, rendered.audio)

    return Response(
        content=body, media_type=fmt.content_type,
        headers={
            **rendered.timing_headers(),
            **extra_headers,
            **rendered.emotion_headers,
            **digest_headers,
            **_ignored_headers(req.voice_settings, req),
            **verify_headers,
        },
    )


# ---------------------------------------------------------------------------
# Verified speech — the API listens to its own output
# ---------------------------------------------------------------------------
# Below this score, ``verify=strict`` spends ONE more render. Deliberately not
# 1.0: a single fumbled word in a long paragraph is not worth doubling the cost
# of the request, while any error in a short line drops the score under this
# floor immediately. Bounded by the same admission window as everything else —
# a busy box refuses the retry and the first render is served with
# X-Fidelity-Retries: 0.
STRICT_FIDELITY_FLOOR = 0.98

_VERIFY_MODES = {"": "off", "0": "off", "false": "off", "no": "off",
                 "off": "off", "1": "on", "true": "on", "yes": "on",
                 "on": "on", "strict": "strict"}

_NO_EARS = (
    "verification needs local speech-to-text, which is not available on this "
    "replica (install faster-whisper via `pip install -r requirements.txt` and "
    "restart, or set STT_MODEL to a model this box can load). Synthesis itself "
    "is unaffected: call this route without ?verify, or use the plain "
    "/v1/text-to-speech route."
)


def _verify_mode(raw: str | None) -> str:
    """``off`` | ``on`` | ``strict`` from the ``?verify=`` parameter.

    An unrecognised value is a 400, never a silent "off": a client that asked
    for verification and got none must be told, not quietly billed for an
    unverified clip it believes was checked.
    """
    if raw is None:
        return "off"
    mode = _VERIFY_MODES.get(str(raw).strip().lower())
    if mode is None:
        raise HTTPException(
            status_code=400,
            detail="unsupported verify value; use verify=true (score the audio "
                   "against the text) or verify=strict (also re-render once "
                   "when it scores badly)")
    return mode


async def _ears_available() -> bool:
    """Whether this replica can transcribe right now. Never on the loop:
    the first call loads the Whisper weights (seconds)."""
    return bool(await _offload(stt.available))


def _transcribe_words(pcm: bytes):
    """Transcribe verification audio WITH word timestamps. Blocking.

    ``stt.transcribe_pcm`` is the conversation path and asks for no word
    timestamps (a turn is waiting on it), so this prefers the kwarg — which is
    what the module SHOULD grow, see the report hook — and falls back to
    ``stt.transcribe``, the public entry point that does take it. Both are
    module-level lookups so the existing test convention (monkeypatching
    ``stt.transcribe_pcm``) keeps working unchanged.
    """
    try:
        return stt.transcribe_pcm(pcm, rate=stt.TARGET_RATE,
                                  word_timestamps=True)
    except TypeError:
        pass
    return stt.transcribe(stt.pcm16_to_float32(pcm), word_timestamps=True)


def _transcribe_plain(pcm: bytes):
    """Transcribe for SCORING only — no word timestamps, no second decode pass.

    Fidelity compares words, not times; buying timestamps for a verdict that
    ignores them would be spending the caller's CPU on nothing.
    """
    return stt.transcribe_pcm(pcm, rate=stt.TARGET_RATE)


async def _listen(audio: CachedAudio, *, words: bool):
    """Feed finished audio back through the ear. Returns an ``stt.Transcript``.

    Both hops are offloaded: WAV → PCM is a wave parse plus a resample, and the
    decode is seconds of CPU. On the event loop either one stalls every other
    request on the replica (repo law; guarded by test_handler_modes).
    """
    pcm = await _offload(convai.wav_to_pcm, audio.wav_bytes, stt.TARGET_RATE)
    return await _offload(_transcribe_words if words else _transcribe_plain, pcm)


def _heard(transcript) -> object:
    """What ``verify.compare`` should score against: timed words when the ear
    produced them, otherwise the flat text (still a real comparison, just
    without spans)."""
    return getattr(transcript, "words", None) or getattr(transcript, "text", "")


async def _retry_once(voice_id: str, req: TTSRequest) -> CachedAudio | None:
    """One extra render of the offending text, or None if it cannot be had.

    Deliberately modest: ONE re-render, submitted through the same admission
    window as any other request, never stored in the cache (the retry exists
    because the first render was wrong — caching it would let a coin-flip decide
    what every later caller hears). A 429 or a timeout here is not an error for
    the caller: the first render is still a complete, honest response, and
    X-Fidelity-Retries reports what actually happened.
    """
    try:
        result = await _submit_and_wait(
            voice_id, req.text, _overrides(req.voice_settings),
            frames_after_eos=req.frames_after_eos)
    except (_Backpressure, HTTPException):
        return None
    return CachedAudio(wav_bytes=result.wav_bytes, sample_rate=result.sample_rate,
                       audio_seconds=result.audio_seconds, segments=1)


async def _verify_rendered(rendered: _Rendered, voice_id: str, req: TTSRequest,
                           mode: str) -> tuple[_Rendered, dict[str, str]]:
    """Score a finished render, optionally re-rendering once (``strict``).

    Degrades exactly like the conversation surface does when a capability is
    missing: the request SUCCEEDS, and the absence is NAMED
    (``X-Fidelity-Unavailable: stt-model-absent``) rather than crashing a
    synthesis that is perfectly good — the caller asked for audio and an
    opinion, and the audio is not in doubt.
    """
    if not await _ears_available():
        logger.info("verify=%s requested but the transcriber is absent: %s",
                    mode, _NO_EARS)
        return rendered, {"X-Fidelity-Score": "unavailable",
                          "X-Fidelity-Unavailable": "stt-model-absent"}

    transcript = await _listen(rendered.audio, words=False)
    report = verify.compare(req.text, _heard(transcript))
    retries = 0
    if (mode == "strict" and report.score is not None
            and report.score < STRICT_FIDELITY_FLOOR):
        second = await _retry_once(voice_id, req)
        if second is not None:
            retries = 1
            again = verify.compare(req.text, _heard(
                await _listen(second, words=False)))
            if again.score is not None and again.score > report.score:
                # The retry really is better — serve it, and say so in the
                # timings: this response now carries audio that was rendered,
                # not replayed, so X-Cache cannot keep claiming a hit.
                rendered.audio = second
                rendered.extra_headers = dict(rendered.extra_headers)
                rendered.extra_headers["X-Cache"] = "miss"
                rendered.extra_headers.pop("X-Synth-Segments", None)
                rendered.was_cached = False
                report = again

    headers = {"X-Fidelity-Score": verify.score_header(report),
               "X-Fidelity-Deltas": verify.deltas_header(report)}
    if mode == "strict":
        headers["X-Fidelity-Retries"] = str(retries)
    return rendered, headers


@dataclass(frozen=True)
class _CachedAlignment:
    """An alignment payload sitting in ALIGN_CACHE beside its audio."""
    data: dict
    size: int

    @property
    def nbytes(self) -> int:
        return self.size


def _alignment_key(key: tuple) -> tuple:
    """The audio's cache identity, plus the ROUTE that derived this entry.

    Without the route component an alignment would share a key with the audio
    it describes — two different things answering to one name, which is how a
    cache starts serving a timeline as a clip.
    """
    return key + ("with-timestamps",)


def _alignment_payload(text: str, transcript, audio: CachedAudio) -> _CachedAlignment:
    """Build the ElevenLabs-shaped alignment block. Pure (service/verify.py)."""
    words = getattr(transcript, "words", None) or []
    alignment = verify.align(text, words, duration_s=audio.audio_seconds)
    report = verify.compare(text, words or getattr(transcript, "text", ""))
    data = {
        "alignment": alignment.characters(text),
        "normalized_alignment": alignment.normalized(),
        # Ours, on top of the compatible shape: the word timeline the character
        # arrays are derived FROM (a caption renderer wants words, not chars),
        # and the verdict the second pass reached while it was in there.
        "words": [w.to_dict() for w in alignment.words],
        "fidelity": report.to_dict(),
        "transcript": getattr(transcript, "text", ""),
        # Say how much of this timeline was measured and how much was inferred.
        # An alignment with anchored=0 (silence, or an ear with no word spans)
        # is evenly spread guesswork, and a dubbing pipeline must be able to
        # tell that apart from a measurement.
        "anchored_words": alignment.anchored,
        "interpolated_words": alignment.interpolated,
    }
    return _CachedAlignment(data, len(json.dumps(data)))


@app.post("/v1/text-to-speech/{voice_id}/with-timestamps",
          dependencies=[Depends(require_scope("tts"))])
# ElevenLabs' streaming timestamps path, served by the SAME handler. It is an
# alias, not a stream: EL's version emits a sequence of JSON alignment frames,
# and ours cannot — the alignment is computed by listening to the FINISHED clip
# (see the docstring), so there is nothing to emit until it exists. A 404 on
# this path told a migrating client "wrong URL", which is a worse answer than
# the complete, correctly-shaped payload it was asking for. The `X-Stream:
# full-body` header on the response says which one it got.
@app.post("/v1/text-to-speech/{voice_id}/stream/with-timestamps",
          dependencies=[Depends(require_scope("tts"))])
async def text_to_speech_with_timestamps(
    voice_id: str,
    req: TTSRequest,
    output_format: str = Query("wav_24000"),
    emotion: str | None = Query(None, description="Gravitone extension: address a Character's emotion voice (or use {character_id}:{emotion} as the path voice_id)"),
    request: Request = None,
):
    """Synthesis WITH a word/character timeline — and a verdict.

    The ElevenLabs-compatible shape (``audio_base64`` + ``alignment`` +
    ``normalized_alignment``), so client code that already consumes
    with-timestamps repoints at this base URL. What is NOT compatible is how it
    is obtained: there is no alignment model here and none is claimed. The
    finished WAV is fed back through the local ASR (service/stt.py) and its word
    spans are mapped onto the words of YOUR text (service/verify.py) — so the
    timeline is over the text you sent, not over what the ear heard, and every
    word says whether its span was measured (``matched: true``) or interpolated
    between its neighbours.

    The synthesis path is the drop-in route's, unchanged and shared
    (``_render_tts``): same segmentation, same cache, same admission, same
    timing headers. Alignment is a POST-step, cached beside the audio in
    ALIGN_CACHE under a route-distinguished key, so a repeated request pays for
    neither the synthesis nor the transcription.

    Without a transcriber this route refuses by NAME (501) instead of returning
    an invented timeline: a fabricated alignment is worse than no alignment,
    because a dubbing pipeline cannot tell it is fabricated.
    """
    assert ENGINE is not None
    fmt = _parse_format(output_format)  # 400s early on an unsupported format
    if not await _ears_available():
        # Refuse BEFORE synthesizing: the caller cannot be given what this route
        # exists to return, so burning a worker on the audio half would be
        # charging for a request that fails anyway.
        raise HTTPException(status_code=501, detail=_NO_EARS)

    rendered = await _render_tts(voice_id, req, emotion, request)
    if isinstance(rendered, JSONResponse):
        return rendered  # backpressure

    async def _build() -> _CachedAlignment:
        transcript = await _listen(rendered.audio, words=True)
        return _alignment_payload(req.text, transcript, rendered.audio)

    if rendered.bypass:
        # The caller said no-store; that covers the alignment too.
        entry, align_cached = await _build(), False
    else:
        entry, align_cached = await ALIGN_CACHE.get_or_synthesize(
            _alignment_key(rendered.key), _build)

    body, format_headers = await _encode_audio(fmt, rendered.audio.wav_bytes,
                                               rendered.audio.sample_rate)
    extra_headers = dict(rendered.extra_headers)
    extra_headers.update(format_headers)
    return JSONResponse(
        content={
            "audio_base64": base64.b64encode(body).decode("ascii"),
            "content_type": fmt.content_type,
            **entry.data,
        },
        headers={
            **rendered.timing_headers(),
            **extra_headers,
            **rendered.emotion_headers,
            **_ignored_headers(req.voice_settings, req),
            # The verdict travels as a header too, so a client that only wants
            # "was it right?" does not have to parse the timeline to find out.
            "X-Fidelity-Score": verify.format_score(
                entry.data["fidelity"]["score"]),
            "X-Alignment-Cache": "hit" if align_cached else "miss",
            # Only on the /stream/with-timestamps alias, so the original path's
            # response is byte-identical to what it always returned.
            **({"X-Stream": "full-body"}
               if request is not None
               and request.url.path.endswith("/stream/with-timestamps") else {}),
        },
    )


_MP3_STREAM_FALLBACK = (
    "mp3 cannot be transcoded incrementally, so this response is the complete "
    "clip in one body rather than a progressive stream. Use output_format="
    "pcm_24000 or wav_24000 for a genuinely chunked stream."
)


async def _stream_mp3_full_body(voice_id: str, req: "TTSRequest",
                                emotion: str | None, fmt: _AudioFormat,
                                request: Request | None):
    """Serve `/stream` + `mp3_*` as one full body, labelled as such.

    Shares the drop-in route's synthesis path (`_render_tts`) rather than
    re-deriving one, so the cache, admission, emotion resolution and timing
    headers are the SAME here as on `/v1/text-to-speech` — a fallback that
    behaved differently from the route it falls back to would be a second
    answer to "what does this request produce".

    Timing headers ARE emitted (unlike the real streaming path, which cannot
    know them when its headers flush) because nothing is progressive here:
    the clip is finished before a byte is written.
    """
    rendered = await _render_tts(voice_id, req, emotion, request)
    if isinstance(rendered, JSONResponse):
        return rendered  # backpressure — identical to the streaming path's 429
    body, format_headers = await _encode_audio(fmt, rendered.audio.wav_bytes,
                                               rendered.audio.sample_rate)
    return Response(
        content=body, media_type=fmt.content_type,
        headers={
            **rendered.timing_headers(),
            **dict(rendered.extra_headers),
            **format_headers,
            **rendered.emotion_headers,
            **_ignored_headers(req.voice_settings, req),
            "X-Stream": "full-body",
            "X-Stream-Fallback": _MP3_STREAM_FALLBACK,
        },
    )


@app.post("/v1/text-to-speech/{voice_id}/stream",
          dependencies=[Depends(require_scope("tts"))])
async def text_to_speech_stream(
    voice_id: str,
    req: TTSRequest,
    output_format: str = Query("wav_24000"),
    emotion: str | None = Query(None, description="Gravitone extension: address a Character's emotion voice (or use {character_id}:{emotion} as the path voice_id)"),
    request: Request = None,
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
    streaming WAV header then raw PCM16 samples.

    `mp3_*` is INCREMENTALLY IMPOSSIBLE here — the transcode needs the complete
    clip — but it is the ElevenLabs SDK's DEFAULT for this endpoint
    (`mp3_44100_128`), so refusing it means an unmodified EL client's
    `stream()` call fails on a base-URL swap. It used to 501 for exactly that
    reason and that was the wrong trade: correctness of the word "stream"
    bought at the price of the drop-in promise. So mp3 renders the whole clip
    and answers with a single full body — the same bytes the non-stream route
    would return, delivered as one chunk. Every mp3 response says so out loud:

        X-Stream: full-body
        X-Stream-Fallback: mp3 cannot be transcoded incrementally …

    That is an honest degradation, not a silent one: a client that cares about
    time-to-first-byte can read the header and switch to `pcm_*`/`wav_*` (which
    genuinely stream), and one that only wanted audio out of `client.stream()`
    gets audio. This is the only format that takes this path.

    Timing headers: the per-synthesis timing headers of the non-stream route
    (X-Synth-Seconds, X-Realtime-Factor, …) are intentionally ABSENT here —
    HTTP response headers are flushed before synthesis completes, so those
    numbers cannot be known when the headers go out. Only pre-stream headers
    (X-Stream, X-Stream-Segments, emotion resolution) are emitted.

    A genuinely saturated engine still rejects the request with 429 up front
    (the first window can't be admitted) rather than truncating mid-stream. The
    whole response is bounded by ONE deadline (``stream_deadline_s``); when it
    expires the stream ends and every un-consumed segment is abandoned.

    The CALLER's ``deadline_s``/``degrade_allowed`` (a different thing from
    ``stream_deadline_s``, which is the server's own truncation bound) reach the
    engine here exactly as they do on the non-streaming route: the first window
    inherits the request's whole horizon, later segments get what is left of it.
    ``X-Gravitone-Deadline`` is emitted only when the entire script fit in the
    first window — otherwise segments are still unadmitted when the headers go
    out and any number would be a guess.
    """
    assert ENGINE is not None
    fmt = _parse_format(output_format)  # 400s early on an unsupported format
    if fmt.kind == "mp3":
        return await _stream_mp3_full_body(voice_id, req, emotion, fmt, request)
    voice_id, emotion_headers = await _resolve_emotion_address(voice_id, emotion)

    chunks = _chunk_text(req.text)
    overrides = _overrides(req.voice_settings)
    window = min(len(chunks), _stream_window())

    # Submit the FIRST WINDOW up front: this decides admission (429) before we
    # commit to a streaming response, keeping backpressure semantics identical
    # to the non-stream route. Workers pick the window up concurrently; the
    # rest is submitted as segments are consumed.
    # The caller's deadline reaches the engine here too. The horizon is the
    # REQUEST's, not the segment's: every segment of the first window inherits
    # it whole (they run concurrently), and each later segment is submitted with
    # whatever is LEFT of it (``elapsed_s`` below) — a segment submitted eight
    # seconds into a ten-second horizon has two seconds, not ten.
    t_admitted = time.monotonic()
    try:
        submitted = _submit_batch([(voice_id, text, overrides)
                                   for text in chunks[:window]],
                                  frames_after_eos=req.frames_after_eos,
                                  deadline_s=req.deadline_s,
                                  degrade_allowed=req.degrade_allowed)
    except AdmissionRejected as exc:
        return _backpressure_response(_Backpressure(str(exc), exc))

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
                            frames_after_eos=req.frames_after_eos,
                            **_contract_kwargs(
                                req.deadline_s, req.degrade_allowed,
                                elapsed_s=time.monotonic() - t_admitted)))
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
        **_ignored_headers(req.voice_settings, req),
    }
    if fmt.kind == "pcm":
        stream_headers["X-Sample-Rate"] = str(fmt.sample_rate)
    # A promise may only ever cover the WHOLE response. If the script did not
    # fit in the first window there are segments not yet admitted, so no honest
    # number exists at header time and none is sent.
    if not pending:
        stream_headers.update(_promise_headers(_batch_promise(submitted)))

    return StreamingResponse(
        _audio_stream(), media_type=fmt.content_type,
        headers=stream_headers,
    )


# ---------------------------------------------------------------------------
# The build plane: /v1/audio/{digest}, /v1/build, /v1/build/plan
# ---------------------------------------------------------------------------

@app.api_route("/v1/audio/{digest}", methods=["GET", "HEAD"],
               dependencies=[Depends(require_scope("tts"))])
async def get_audio(digest: str, request: Request = None):
    """Fetch an artifact by its digest — the read half of the build plane.

    A digest is a NAME, not a promise that anything was rendered, so an absent
    one is an ordinary 404 that says so by name (``buildstore.AUDIO_NOT_FOUND``)
    and tells the caller how to make it exist. A malformed one is a 400: nothing
    that is not 64 hex characters is allowed anywhere near a filesystem path.

    ``HEAD`` answers the existence question without moving the bytes — that is
    what a CI job asks 5,000 times before deciding what to render.

    The stored ``Content-Type`` is served back verbatim because the digest is
    FORMAT-AWARE: ``mp3_24000_128`` and ``wav_24000`` of the same line are
    different names, so an artifact is never re-encoded on the way out and can
    never contradict the name it was fetched under.
    """
    try:
        buildstore.parse_digest(digest)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    head_only = request is not None and request.method == "HEAD"
    entry = await _offload(BUILD_STORE.head if head_only else BUILD_STORE.get,
                           digest)
    if entry is None:
        raise HTTPException(status_code=404, detail=buildstore.AUDIO_NOT_FOUND)

    headers = {
        **_digest_headers(f"sha256:{entry.digest}"),
        "X-Audio-Seconds": str(entry.audio_seconds),
        "Cache-Control": "public, max-age=31536000, immutable",
    }
    if entry.sample_rate:
        headers["X-Sample-Rate"] = str(entry.sample_rate)
    if head_only:
        # A HEAD carries the metadata of the GET and none of its bytes — so the
        # length is stated explicitly rather than derived from an empty body.
        headers["Content-Length"] = str(await _offload(BUILD_STORE.size_of, digest))
        return Response(status_code=200, media_type=entry.content_type,
                        headers=headers)
    return Response(content=entry.data, media_type=entry.content_type,
                    headers=headers)


class BuildLine(BaseModel):
    """One line of a manifest: who says what, and in which format."""
    id: str = Field(..., min_length=1, max_length=200)
    voice: str = Field(..., min_length=1, max_length=200)
    text: str = Field(..., min_length=1, max_length=8000)
    emotion: str | None = None
    settings: VoiceSettings | None = None
    format: str | None = None
    frames_after_eos: int | None = None


class BuildRequest(BaseModel):
    # Capped by a NAMED setting (buildstore.BUILD_MANIFEST_MAX_LINES): every
    # line is submitted through the same admission window as any other request,
    # so an unbounded manifest is a way for one caller to hold the pool.
    lines: list[BuildLine] = Field(
        ..., min_length=1, max_length=buildstore.BUILD_MANIFEST_MAX_LINES)
    # PER-LINE horizon, not a budget for the whole manifest: a build is a
    # variable number of independent renders spread over as many waves as the
    # pool's parallelism needs, so "this build must finish in 5s" is not a thing
    # the scheduler can act on, while "schedule each of my lines against a 5s
    # horizon" is exactly what the queue key consumes. Each line is one render
    # and gets the WHOLE number — never a 1/N slice, which would make a long
    # manifest look more urgent per line than a short one.
    deadline_s: float | None = Field(None, gt=0, le=3600)
    # Accepted so it can be REFUSED loudly rather than ignored silently — see
    # build()'s 400. A build artifact is content-addressed and elastic quality
    # would change the bytes without changing the digest.
    degrade_allowed: bool = False


async def _manifest_identity(lines: list[BuildLine]) -> tuple[list[dict], str]:
    """Resolve and NAME every line of a manifest. Returns (rows, engine_version).

    Each row is ``{"id", "voice" (resolved), "format", "overrides", "digest"}``
    in manifest order — the identity half of every build route, shared so that
    plan, lock and build cannot drift into three different answers.

    Fails the whole manifest on an unknown voice/character, naming the line — a
    build that silently skipped a line would produce a lockfile with a hole in
    it — and it fails on the FIRST bad line, so resolution stays sequential and
    in order (``_resolve_emotion_address`` also records fallbacks in the emotion
    demand ledger, which is order- and count-sensitive).

    Naming, by contrast, is one batch: the digests for the whole manifest are
    computed in a SINGLE executor hop, which is what takes the per-line
    ``Path.stat()`` of ``_voice_fingerprint`` and the per-line sha256 off the
    event loop, and ``_RequestIdentity`` hoists the version strings out of the
    loop entirely. The inputs to each digest are unchanged, so every store
    written by the old per-line path is still addressed by the same name.
    """
    rows: list[dict] = []
    for i, line in enumerate(lines):
        fmt_str = (line.format or "wav_24000")
        _parse_format(fmt_str)  # 400s on an unsupported format, before any work
        try:
            resolved, _emotion_headers = await _resolve_emotion_address(
                line.voice, line.emotion)
        except HTTPException as exc:
            raise HTTPException(status_code=exc.status_code,
                                detail=f"line {i} ({line.id!r}): {exc.detail}")
        rows.append({"id": line.id, "voice": resolved, "format": fmt_str,
                     "overrides": _overrides(line.settings)})

    def _name_them() -> tuple[list[str], str]:
        ident = _RequestIdentity()
        return ([ident.digest(row["voice"], line.text, row["overrides"],
                              line.frames_after_eos, row["format"])
                 for row, line in zip(rows, lines)],
                ident.engine_version)

    digests, engine_version = await _offload(_name_them)
    for row, digest in zip(rows, digests):
        row["digest"] = digest
    return rows, engine_version


def _lock_lines(rows: list[dict], engine_version: str) -> list[dict]:
    """The lockfile/record shape of a named manifest, in MANIFEST order.

    Order matters even though ``lockfile`` and ``build_id`` sort: the build
    record keeps this list as-is and ``zip_member_names`` walks it, so the
    archive's member order is the order the caller wrote their script in —
    never the order the pool happened to finish rendering it.
    """
    return [{"id": row["id"], "digest": row["digest"], "voice": row["voice"],
             "format": row["format"], "engine_version": engine_version}
            for row in rows]


async def _stored_digests(digests: list[str]) -> set[str]:
    """Which of these digests the artifact store already holds. ONE offload.

    ``BUILD_STORE.has`` is a single ``is_file()``, but a manifest asked it once
    per line through ``_offload`` — 300 lines were 300 executor round-trips
    before the first worker was woken, each one a hop the event loop pays for.
    Deduped first, because a manifest may legitimately name the same audio twice.
    """
    wanted = list(dict.fromkeys(digests))
    if not wanted:
        return set()
    return set(await _offload(
        lambda: [digest for digest in wanted if BUILD_STORE.has(digest)]))


async def _render_build_line(line: BuildLine, row: dict,
                             deadline_s: float | None):
    """Render ONE build line and store its artifact under the row's digest.

    Returns the response fragment for a rendered line, or the ordinary 429
    JSONResponse when admission refused — backpressure is a RESPONSE here for
    the same reason it is in ``_render_tts``: so a wave can settle around it
    instead of each caller re-deriving it from an exception.

    The emotion address is handed to ``_render_tts`` ALREADY resolved (the row
    holds what ``_manifest_identity`` resolved to compute the digest): resolving
    twice would count this line twice in the emotion demand ledger.
    """
    fmt = _parse_format(row["format"])
    tts_req = TTSRequest(text=line.text, voice_settings=line.settings,
                         frames_after_eos=line.frames_after_eos,
                         deadline_s=deadline_s)
    rendered = await _render_tts(line.voice, tts_req, line.emotion, None,
                                 resolved=(row["voice"], {}))
    if isinstance(rendered, JSONResponse):
        return rendered
    body, _format_headers = await _encode_audio(
        fmt, rendered.audio.wav_bytes, rendered.audio.sample_rate)
    await _store_artifact(row["digest"], body, fmt, rendered.audio)
    return {"bytes": len(body), "audio_seconds": rendered.audio.audio_seconds}


@app.post("/v1/build/plan", dependencies=[Depends(require_scope("tts"))])
async def build_plan(req: BuildRequest):
    """Dry run: what WOULD this manifest change? No synthesis, no bytes.

    The CI primitive. Because a digest is computed from the inputs, this answer
    is exact and costs nothing: a 5,000-line script where two lines were edited
    reports 4,998 ``fresh`` and 2 ``would_render`` without waking a worker.
    Run it in a pull request and you know the audio diff before you pay for it.
    """
    rows, _engine_version = await _manifest_identity(req.lines)
    stored = await _stored_digests([row["digest"] for row in rows])
    lines = [{"id": row["id"], "digest": row["digest"], "format": row["format"],
              "state": "fresh" if row["digest"] in stored else "would_render"}
             for row in rows]
    return {
        "lines": lines,
        "fresh": sum(1 for l in lines if l["state"] == "fresh"),
        "would_render": sum(1 for l in lines if l["state"] == "would_render"),
        # The id this manifest WOULD build to. Reported by the dry run because
        # it is a function of the inputs: a plan that reports the same build_id
        # as the lockfile in your repo is the cheapest possible "nothing moved".
        "build_id": buildstore.build_id(lines),
        "identity_version": buildstore.IDENTITY_VERSION,
    }


@app.post("/v1/build/lock", dependencies=[Depends(require_scope("tts"))])
async def build_lock(req: BuildRequest):
    """Emit ``gravitone.lock`` for a manifest. No synthesis, no bytes, no clock.

    The document a team COMMITS. Its schema is documented on
    ``buildstore.lockfile`` and versioned by ``schema_version``; it holds only
    values derived from the inputs (digest, resolved voice, engine version,
    format) so its diff is exactly the set of lines whose audio would change —
    nothing about when it was generated, on which host, or by whom.

    A manifest with two lines sharing an id is refused by name: the file is
    keyed by id, so locking it would silently drop one of them.
    """
    dupes = buildstore.duplicate_line_ids([{"id": ln.id} for ln in req.lines])
    if dupes:
        raise HTTPException(status_code=422,
                            detail=buildstore.DUPLICATE_LINE_ID + ", ".join(dupes))
    rows, engine_version = await _manifest_identity(req.lines)
    return buildstore.lockfile(_lock_lines(rows, engine_version))


@app.post("/v1/build", dependencies=[Depends(require_scope("tts"))])
async def build(req: BuildRequest):
    """Render a manifest incrementally. Returns digests, never audio bytes.

    Per line: ``fresh`` (the artifact is already in the store under that exact
    digest — nothing was rendered) or ``rendered`` (it was synthesized now and
    stored). The response is deliberately byte-free: a build's product is a
    LOCKFILE, and the audio is fetched by digest from ``/v1/audio/{digest}`` by
    whoever actually needs it. Two lines with identical inputs share one digest
    and are rendered once.

    Synthesis goes through the SAME path as a plain ``/v1/text-to-speech`` call
    (``_render_tts`` → ``_encode_audio``), which is why a build line and an
    ordinary call with the same inputs report the same digest and produce the
    same artifact — the two must never be two synthesis paths.

    AND IT GOES THROUGH THE POOL, not one line at a time. This route is the one
    made for 300-line scripts and was the only synthesis path that rendered
    strictly sequentially, taking N× the serial latency of a script that
    /v1/speak and /v1/performance would have rendered in waves. Lines are
    rendered in waves of ``_max_batch_units()`` UNITS (``_pack_waves``) — the
    same budget, from the same function, as every other batched route, because
    two different answers to "how many units may one request submit" would be
    worse than one wrong one.

    Concurrency is invisible in the ARTIFACT, which is the whole point: the
    lockfile, the build id, the response lines and the zip are all assembled
    from the manifest-ordered rows, never from completion order, and each line's
    bytes are stored under a digest computed before a worker was woken. Which
    lines happen to share a wave, and which finishes first, changes nothing a
    caller can observe. (Worker COUNT is a different matter and always was: it
    is folded into ``_segmentation_version`` because it decides where a long
    line's seams land, and seams are audible.)

    Admission is untouched and shared: a saturated pool returns the ordinary 429
    + ``Retry-After``, and the lines already rendered are already stored, so a
    retried build resumes instead of restarting. A rejection mid-manifest now
    resumes from FURTHER along than it used to: the refused line's in-flight
    siblings are awaited and stored rather than thrown away (they are finished
    audio, not a burning worker slot — the same trade
    ``_submit_and_gather_in_waves`` makes), and the 429 is still returned
    before any build record is written.

    ``deadline_s`` reaches the engine for every line it renders (a PER-LINE
    horizon — see BuildRequest). ``degrade_allowed`` is REFUSED with a 400
    rather than honoured: a build artifact is named by a digest computed from
    its inputs, so a cheaper render would put different bytes under the same
    name — the one failure the DIGEST LAW (service/buildstore.py) exists to
    prevent. Elastic quality belongs on the routes that hand back audio, where
    ``X-Quality-Level`` tells the caller what they got.
    """
    assert ENGINE is not None
    if req.degrade_allowed:
        raise HTTPException(
            status_code=400,
            detail="degrade_allowed is not available on /v1/build: a build "
                   "artifact is named by a digest over its inputs, and a "
                   "cheaper render would store different bytes under that same "
                   "name. Use deadline_s alone here, or the /v1/text-to-speech "
                   "routes if you want elastic quality.")
    rows, engine_version = await _manifest_identity(req.lines)
    lock_lines = _lock_lines(rows, engine_version)
    stored = await _stored_digests([row["digest"] for row in rows])

    # WHICH lines actually run: the FIRST occurrence of each unstored digest.
    # Deduping before dispatch (rather than as the sequential loop's
    # ``rendered_now`` did, after each render) is what keeps "two lines with
    # identical inputs are rendered once" true when the two would otherwise be
    # in the same wave.
    todo: dict[str, int] = {}
    for i, row in enumerate(rows):
        if row["digest"] not in stored and row["digest"] not in todo:
            todo[row["digest"]] = i
    pending = list(todo.values())

    cap = max(1, _max_batch_units())
    # A line's weight is the unit count ``_render_tts`` will submit for it —
    # the same pure ``_chunk_text`` call it makes — so a wave never exceeds the
    # unit budget just because its lines were long.
    weights = [len(_chunk_text(req.lines[i].text, max_units=cap))
               for i in pending]
    outcome: dict[str, dict] = {}
    for wave in _pack_waves(weights, cap):
        # return_exceptions: a sibling that already finished has already stored
        # its artifact, and cancelling it mid-await would throw away audio a
        # retry would otherwise find fresh. The problem is raised (or returned)
        # after the wave settles, in manifest order, so WHICH line fails a
        # manifest does not depend on scheduling.
        settled = await asyncio.gather(
            *(_render_build_line(req.lines[pending[k]], rows[pending[k]],
                                 req.deadline_s) for k in wave),
            return_exceptions=True)
        problem = None
        for k, result in zip(wave, settled):
            if isinstance(result, dict):
                outcome[rows[pending[k]]["digest"]] = result
            elif problem is None:
                problem = result
        if isinstance(problem, JSONResponse):
            return problem  # backpressure — same 429 every other route returns
        if problem is not None:
            raise problem

    results = []
    for i, row in enumerate(rows):
        # ``todo[digest] == i`` and not merely "this digest was rendered": the
        # repeat of a digest is ``fresh`` off its twin's render, exactly as the
        # sequential loop reported it.
        got = outcome.get(row["digest"]) if todo.get(row["digest"]) == i else None
        entry = {"id": row["id"], "digest": row["digest"],
                 "format": row["format"],
                 "state": "rendered" if got is not None else "fresh"}
        if got is not None:
            entry.update(got)
        results.append(entry)
    build_ident = await _record_build(lock_lines)
    return {
        "lines": results,
        "fresh": sum(1 for l in results if l["state"] == "fresh"),
        "rendered": sum(1 for l in results if l["state"] == "rendered"),
        # The name of this build: fetch every artifact at once from
        # GET /v1/build/{build_id}.zip, or line by line from /v1/audio/{digest}.
        "build_id": build_ident,
        "identity_version": buildstore.IDENTITY_VERSION,
    }


async def _record_build(lock_lines: list[dict]) -> str:
    """Persist the skeleton of a finished build and return its id.

    The record owns no audio — it names digests the artifact store already
    holds, which is why it is capped by count and why an evicted artifact makes
    the zip a named 410 instead of making this record a lie. A record that
    cannot be written is logged, never raised: every digest is already in the
    response and ``/v1/audio/{digest}`` still serves each one individually.
    """
    build_ident = buildstore.build_id(lock_lines)
    record = {
        "schema_version": buildstore.BUILD_RECORD_SCHEMA_VERSION,
        "build_id": build_ident,
        "identity_version": buildstore.IDENTITY_VERSION,
        "lines": [{"id": ln["id"], "digest": ln["digest"], "format": ln["format"]}
                  for ln in lock_lines],
    }
    try:
        # A manifest MAY repeat a line id (two lines can legitimately be the
        # same audio); a lockfile may not. When it does, the zip ships without
        # the lock member rather than with a lock that dropped a line.
        record["lock"] = buildstore.lockfile(lock_lines)
    except ValueError:
        pass
    await _offload(BUILD_STORE.put_record, record)
    return build_ident


@app.get("/v1/build/{build_id}.zip", dependencies=[Depends(require_scope("tts"))])
async def get_build_zip(build_id: str):
    """Every artifact of one build, streamed as a zip, plus its lockfile.

    The convenience half of the build plane: CI already knows each digest and
    can fetch them one at a time, but a human who just built a 300-line script
    wants one file. Nothing is re-rendered here — this route reads the store and
    only the store, so a zip is exactly as expensive as the bytes it moves.

    Bounded and honest about its edges, all named:
      * unknown build id -> 404 ``BUILD_NOT_FOUND``;
      * known build whose audio was evicted by the LRU budget -> 410
        ``BUILD_PRUNED``, listing the digests, checked BEFORE a byte is sent so
        a caller never has to tell a truncated download from a complete one;
      * a build larger than ``GRAVITONE_BUILD_ZIP_MAX_BYTES`` -> 413 naming the
        budget and pointing at the per-digest route.

    Members are stored (not deflated) with a fixed timestamp, so the archive of
    an unchanged build is byte-identical every time it is fetched.
    """
    try:
        bare = buildstore.parse_build_id(build_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    record = await _offload(BUILD_STORE.get_record, bare)
    if record is None:
        raise HTTPException(status_code=404, detail=buildstore.BUILD_NOT_FOUND)

    lines = [ln for ln in (record.get("lines") or []) if ln.get("digest")]
    # ONE executor hop for the whole pre-flight, not one per line: a 300-line
    # build used to be 300 thread round-trips before its first byte moved, all
    # of them to ask for a stat. (The member READS stay lazy and per line —
    # they are the point of streaming, and Starlette already iterates this
    # sync generator off the loop.)
    sizes = await _offload(
        lambda: [BUILD_STORE.size_of(ln["digest"]) for ln in lines])
    missing = [ln["digest"] for ln, size in zip(lines, sizes) if not size]
    total = sum(sizes)
    if missing:
        raise HTTPException(status_code=410,
                            detail=buildstore.BUILD_PRUNED + ", ".join(missing))
    budget = buildstore.zip_max_bytes()
    if total > budget:
        raise HTTPException(
            status_code=413,
            detail=f"{buildstore.ZIP_TOO_LARGE}{total}/{budget}")

    names = buildstore.zip_member_names(lines)
    lock = record.get("lock")

    def _members():
        if lock:
            yield "gravitone.lock", buildstore.lockfile_bytes(lock)
        for name, line in zip(names, lines):
            entry = BUILD_STORE.get(line["digest"])
            if entry is None:
                # Evicted between the pre-flight check and this read. A zip that
                # simply omits the member would be a VALID archive missing a
                # file — a silent lie — so the transfer fails instead.
                logger.warning("build %s lost %s mid-stream", bare, line["digest"])
                raise RuntimeError(buildstore.BUILD_PRUNED + str(line["digest"]))
            yield name, entry.data

    return StreamingResponse(
        buildstore.stream_zip(_members()),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="gravitone-{bare[:12]}.zip"',
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


# Voice + Character management lives in service/voices.py. Read endpoints
# (list voices/characters/emotions) accept a tts-scoped key so ElevenLabs
# drop-in clients work; mutations need the "voices" scope.
app.include_router(voices_router, dependencies=[
    Depends(require_read_write("tts", "voices")), Depends(DEMO_CLONE_BUDGET)])
# API key management (issue / rotate / revoke) — root TTS_API_KEY only.
app.include_router(keys_router, dependencies=[Depends(require_scope("admin"))])
# Character ingestion (scan a recording → review → commit) — "clone" scope.
# The scope is mounted here; the per-IP BUDGETS are declared on the two
# expensive routes themselves (`ingest_api.SCAN_BUDGET` / `AUDITION_BUDGET`,
# env `TTS_BUDGET_INGEST_SCAN` / `TTS_BUDGET_INGEST_AUDITION`) rather than on
# this mount, because a router-level dependency would charge the pollers too —
# GET /v1/ingest/{job} is called every second by a client watching a scan, and
# a budget that refuses the progress poller for the scan it is watching is
# worse than no budget at all. Same limiter, same describe()-quoting 429.
app.include_router(ingest_router, dependencies=[Depends(require_scope("clone"))])
# Voiceover (narrate a silent video with an existing Character) — it renders
# with voices that already exist, so the synthesis scope is the right gate;
# creating the Character stays behind "clone" above.
from service.voiceover_api import router as voiceover_router  # noqa: E402

app.include_router(voiceover_router, dependencies=[Depends(require_scope("tts"))])
# Re-voice (replace the dialogue in an analyzed video with cloned Characters,
# from the studio's edited scene lines) — same reasoning, same scope.
from service.revoice_api import router as revoice_router  # noqa: E402

app.include_router(revoice_router, dependencies=[Depends(require_scope("tts"))])
# Character Packs (export/import portable bundles) — exporting hands out the
# raw voice embeddings, so both directions need the "voices" scope.
app.include_router(packs_router, dependencies=[Depends(require_scope("voices"))])
# Shared takes (public Voice Cards) — reads/writes ride the web proxy's key;
# direct API access needs a tts-scoped key.
app.include_router(takes_router, dependencies=[Depends(require_scope("tts"))])
# Review sets (client approval links) — same surface, same scope.
app.include_router(reviews_router, dependencies=[Depends(require_scope("tts"))])
# Direction corpus (what re-performances change) - same surface, same scope.
app.include_router(direction_router, dependencies=[Depends(require_scope("tts"))])
# Audible Docs: a URL / markdown / HTML body -> a segmented, emotion-tagged
# narration PLAN. It synthesizes nothing; every block is rendered lazily through
# the ordinary TTS routes, so it carries the same tts scope they do.
app.include_router(narrate_router, dependencies=[Depends(require_scope("tts"))])
# Local transcription (service/stt.py) — its own scope: hearing a recording is
# a different capability from speaking one, and a drop-in TTS client has no
# business transcribing.
app.include_router(stt_router, dependencies=[Depends(require_scope("stt"))])
# Conversational agents (service/convai.py). TWO routers on purpose: the HTTP
# half mints the signed URL and is scope-checked like everything else, while the
# socket half authenticates on the ticket in that URL. A browser cannot put an
# xi-api-key header on a WebSocket handshake, so applying an auth dependency to
# the socket would lock out the exact client this surface exists for.
app.include_router(convai_router, dependencies=[Depends(require_scope("convai"))])
app.include_router(convai_ws_router)
# Replay drives the same conversation surface it tests, so it carries the same scope.
app.include_router(gym_router, dependencies=[Depends(require_scope("convai"))])
# What this artifact IS. Root-only for now — the manifest names every model on disk.
app.include_router(appliance_router, dependencies=[Depends(require_scope("admin"))])
# The engine plane (service/engines.py): what each adapter DECLARES it can do,
# and what conformance actually observed. Read-only, so a tts-scoped key sees it
# — a drop-in client choosing a language needs to know which engines exist.
app.include_router(engines_router, dependencies=[Depends(require_scope("tts"))])
# The conversation session speaks through the same worker pool as every other
# route, but it cannot import this module to reach it (that is the import cycle
# — app imports the router). So the pool is handed over instead; the lambda
# defers the read until a session actually synthesizes, by which time the
# lifespan has built it.
convai.set_engine_provider(lambda: ENGINE)
# Same seam, same reason, for the engine plane: service/engines.py describes the
# pocket-tts adapter (its voices, its observed sample rate) and needs the LIVE
# pool to do it, but importing this module would be the cycle. The lambda defers
# the read until an engine is actually asked about itself, by which time the
# lifespan has built ENGINE. Without this it falls back to convai's provider —
# the same object, one indirection further away.
engines_plane.set_pool_provider(lambda: ENGINE)


class SpeakRequest(BaseModel):
    character_id: str
    text: str = Field(..., min_length=1, max_length=8000)
    voice_settings: VoiceSettings | None = None
    # The deadline contract, same field names and same meaning as TTSRequest:
    # the horizon is the REQUEST's, and every segment of it inherits that
    # horizon (see _submit_batch). Absent = the previous behaviour exactly.
    deadline_s: float | None = Field(None, gt=0, le=3600)
    degrade_allowed: bool = False


@app.post("/v1/speak",
          dependencies=[Depends(require_scope("tts")), Depends(SPEAK_BUDGET)])
async def speak(
    req: SpeakRequest,
    output_format: str = Query("wav_24000"),
):
    """Speak metatagged text with one Character, switching Voices per emotion.

        "Hello. [excited]This is amazing![/excited] [sad]But now I'm sad."

    Emotions the Character lacks fall back to its baseline Voice. The per-segment
    report (what was requested vs what was used) is returned base64-JSON in the
    `X-Segments` header so the UI can show the substitutions.

    Timing headers mirror the drop-in route's contract: ``X-Synth-Seconds`` is
    the WALL-CLOCK time this request spent synthesizing (submission to concat),
    never the sum of the per-segment times — the segments run concurrently, so a
    sum reports a duration that never elapsed and a realtime factor that never
    existed. ``X-Queue-Seconds`` is the worst segment's admission wait (the
    request is only as fast as its slowest queued segment) and
    ``X-Synth-Segments`` says how many jobs the script became.

    Not cached: unlike the drop-in route, /v1/speak has no result cache, so
    there is no ``X-Cache`` header to report — a header that always said "miss"
    would be noise, not a diagnostic.

    ``output_format`` is the SAME grammar the drop-in route honours
    (``_parse_format``): mp3 bitrates, pcm and wav at any supported rate, with
    an early 400 listing what IS supported. It defaults to ``wav_24000``, the
    native rate, so a caller that never passes it gets exactly the bytes it got
    before the parameter existed.
    """
    assert ENGINE is not None
    fmt = _parse_format(output_format)  # 400s early on an unsupported format

    emap = emotion_map(req.character_id)
    if not emap:
        raise HTTPException(status_code=404, detail=f"unknown character '{req.character_id}'")
    pmap = prosody_map(req.character_id)  # one registry read, not one per segment

    segments = parse_segments(req.text)
    overrides = _overrides(req.voice_settings)

    # Resolve every segment's voice, then submit in WAVES bounded by this
    # process's real parallelism (_submit_and_gather_in_waves): a wave is
    # submitted before any of it is awaited, so the pool runs it concurrently
    # instead of paying N× latency serially, while a long script can no longer
    # 429 itself by claiming more of the admission window than there are workers
    # to use. Admission (429) is decided at submit time; if any segment is
    # rejected the whole request fails with 429 and that wave's already-submitted
    # segments are abandoned (see _submit_batch) rather than burning worker slots
    # for a response that will never be sent.
    resolved: list[tuple] = []
    fallbacks: list[tuple[str, str]] = []
    for seg in segments:
        voice_id, used, fell_back = resolve(seg.emotion, emap, prosody=pmap)
        if fell_back:
            fallbacks.append((req.character_id, seg.emotion))
        resolved.append((seg, voice_id, used, fell_back))
    if fallbacks:  # one executor hop, not one disk write per segment
        await _offload(_record_fallbacks, fallbacks)

    t_start = time.perf_counter()
    promise: dict = {}
    try:
        results = await _submit_and_gather_in_waves(
            [(voice_id, seg.text, overrides)
             for (seg, voice_id, used, fell_back) in resolved],
            deadline_s=req.deadline_s, degrade_allowed=req.degrade_allowed,
            promise=promise)
    except AdmissionRejected as exc:
        return _backpressure_response(_Backpressure(str(exc), exc))

    wavs: list[bytes] = []
    report: list[dict] = []
    total_audio = 0.0
    for (seg, voice_id, used, fell_back), result in zip(resolved, results):
        wavs.append(result.wav_bytes)
        total_audio += result.audio_seconds
        report.append({
            "text": seg.text, "requested": seg.emotion, "used": used,
            "fallback": fell_back, "voice_id": voice_id, "seconds": result.audio_seconds,
        })

    wav_bytes = await _offload(concat_wavs, wavs)
    # Wall-clock for the WHOLE request, not the sum of per-segment synth times:
    # the segments ran concurrently, so summing them would report a duration
    # that never elapsed (and a realtime factor that never was). Same shape as
    # the drop-in route's batch path. Measured before the format conversion, so
    # it stays a claim about the MODEL and X-Realtime-Factor is comparable
    # across output formats.
    synth_seconds = round(time.perf_counter() - t_start, 3)
    queue_seconds = round(max((r.queue_seconds for r in results), default=0.0), 3)
    body, format_headers = await _encode_audio(fmt, wav_bytes, results[0].sample_rate)
    return Response(
        content=body, media_type=fmt.content_type,
        headers={
            "X-Audio-Seconds": str(round(total_audio, 2)),
            "X-Synth-Seconds": str(synth_seconds),
            "X-Queue-Seconds": str(queue_seconds),
            "X-Realtime-Factor": (str(round(total_audio / synth_seconds, 3))
                                  if synth_seconds else "n/a"),
            "X-Segments": base64.b64encode(json.dumps(report).encode()).decode(),
            **({"X-Synth-Segments": str(len(results))} if len(results) > 1 else {}),
            **_promise_headers(promise),
            **format_headers,
            **_ignored_headers(req.voice_settings),
        },
    )


async def _speak_for_take(character_id: str, text: str) -> dict:
    """Public re-perform renders through the SAME machinery /v1/speak uses.
    Handed over instead of imported: takes.py cannot import this module (it is
    the router this module imports) — same seam as convai.set_engine_provider."""
    resp = await speak(SpeakRequest(character_id=character_id, text=text),
                       output_format="wav_24000")
    if getattr(resp, "status_code", 200) != 200:  # backpressure JSON, not audio
        raise HTTPException(resp.status_code,
                            "the render queue is full - try again shortly")
    report = json.loads(base64.b64decode(resp.headers.get("X-Segments", "")) or b"[]")
    rtf = resp.headers.get("X-Realtime-Factor", "")
    return {"audio": resp.body, "segments": report,
            "seconds": float(resp.headers.get("X-Audio-Seconds", 0) or 0),
            "rtf": float(rtf) if rtf.replace(".", "", 1).isdigit() else 0.0}


takes_plane.set_speak_provider(_speak_for_take)


class PerformanceLine(BaseModel):
    """One directed line: a Character speaking (optionally metatagged) text."""
    character_id: str
    text: str = Field(..., min_length=1, max_length=8000)
    voice_settings: VoiceSettings | None = None


class PerformanceRequest(BaseModel):
    lines: list[PerformanceLine] = Field(..., min_length=1, max_length=64)
    # The deadline contract for the WHOLE performance (see SpeakRequest): one
    # horizon for the response, inherited by every line's every segment. A
    # per-line deadline would be a different feature — a performance is one
    # piece of audio, and the caller waits for all of it.
    deadline_s: float | None = Field(None, gt=0, le=3600)
    degrade_allowed: bool = False


@app.post("/v1/performance",
          dependencies=[Depends(require_scope("performance")),
                        Depends(PERFORMANCE_BUDGET)])
async def performance(req: PerformanceRequest,
                      output_format: str = Query("wav_24000")):
    """Character Performance API — a multi-character script in one call.

    Each line names a Character; its text may use the same emotion metatags
    as /v1/speak ("[excited]...[/excited]"). Voices switch per character AND
    per emotion, missing emotions fall back to baseline, and the full
    line/segment substitution report comes back base64-JSON in
    X-Performance-Report. Premium surface: requires the "performance" key
    scope (the root key always passes).

    Timing headers follow /v1/speak's contract: ``X-Synth-Seconds`` is the
    request's WALL-CLOCK synthesis time (the segments run concurrently, so the
    per-segment sum is a duration that never elapsed), ``X-Queue-Seconds`` the
    worst segment's admission wait, ``X-Synth-Segments`` the job count. Not
    cached, so no ``X-Cache``.

    ``output_format`` is the same grammar as the drop-in route and /v1/speak
    (``_parse_format``), defaulting to ``wav_24000``. It matters most here: a
    multi-character performance is the output someone actually wants to share,
    and mp3 is how you share it.
    """
    assert ENGINE is not None
    fmt = _parse_format(output_format)  # 400s early on an unsupported format

    ignored = sorted({s for line in req.lines for s in _ignored_settings(line.voice_settings)},
                     key=["similarity_boost", "style"].index)

    # Fail fast: validate every character before synthesizing anything.
    emaps: dict[str, dict[str, str]] = {}
    pmaps: dict[str, dict[str, dict]] = {}
    for i, line in enumerate(req.lines):
        if line.character_id not in emaps:
            emap = emotion_map(line.character_id)
            if not emap:
                raise HTTPException(status_code=404,
                                    detail=f"unknown character '{line.character_id}' (line {i})")
            emaps[line.character_id] = emap
            pmaps[line.character_id] = prosody_map(line.character_id)

    # Flatten every line into its emotion segments, resolving voices first, then
    # submit in waves bounded by real parallelism and gather in order — an
    # N-segment script occupies up to WORKERS at once instead of serialising,
    # and a 64-line ensemble no longer submits hundreds of segments into a
    # 33-slot window. A rejected segment fails the whole request with 429 (see
    # /v1/speak and _submit_and_gather_in_waves for the rationale).
    tasks: list[tuple] = []  # (line_idx, character_id, seg, voice_id, used, fell_back)
    fallbacks: list[tuple[str, str]] = []
    for i, line in enumerate(req.lines):
        emap = emaps[line.character_id]
        overrides = _overrides(line.voice_settings)
        for seg in parse_segments(line.text):
            voice_id, used, fell_back = resolve(seg.emotion, emap,
                                                prosody=pmaps[line.character_id])
            if fell_back:
                fallbacks.append((line.character_id, seg.emotion))
            tasks.append((i, line.character_id, seg, voice_id, used, fell_back, overrides))
    if fallbacks:  # one executor hop, not one disk write per segment
        await _offload(_record_fallbacks, fallbacks)

    t_start = time.perf_counter()
    promise: dict = {}
    try:
        results = await _submit_and_gather_in_waves(
            [(t[3], t[2].text, t[6]) for t in tasks],
            deadline_s=req.deadline_s, degrade_allowed=req.degrade_allowed,
            promise=promise)
    except AdmissionRejected as exc:
        return _backpressure_response(_Backpressure(str(exc), exc))

    wavs: list[bytes] = []
    report: list[dict] = []
    total_audio = 0.0
    for (i, character_id, seg, voice_id, used, fell_back, _overr), result in zip(tasks, results):
        wavs.append(result.wav_bytes)
        total_audio += result.audio_seconds
        report.append({
            "line": i, "character_id": character_id, "text": seg.text,
            "requested": seg.emotion, "used": used, "fallback": fell_back,
            "voice_id": voice_id, "seconds": result.audio_seconds,
        })

    wav_bytes = await _offload(concat_wavs, wavs)
    # Wall-clock, not the per-segment sum — see /v1/speak.
    synth_seconds = round(time.perf_counter() - t_start, 3)
    queue_seconds = round(max((r.queue_seconds for r in results), default=0.0), 3)
    body, format_headers = await _encode_audio(fmt, wav_bytes, results[0].sample_rate)
    return Response(
        content=body, media_type=fmt.content_type,
        headers={
            "X-Audio-Seconds": str(round(total_audio, 2)),
            "X-Synth-Seconds": str(synth_seconds),
            "X-Queue-Seconds": str(queue_seconds),
            "X-Realtime-Factor": (str(round(total_audio / synth_seconds, 3))
                                  if synth_seconds else "n/a"),
            "X-Performance-Report": base64.b64encode(json.dumps(report).encode()).decode(),
            **({"X-Synth-Segments": str(len(results))} if len(results) > 1 else {}),
            **_promise_headers(promise),
            **format_headers,
            **({"X-Ignored-Settings": ",".join(ignored)} if ignored else {}),
        },
    )


# Scope that unlocks the operational DETAIL on /health and /metrics: the engine
# config (worker counts, thread budgets, quantization, the whole Arm tuning
# dict) and the latency percentiles. "tts" rather than "admin" so a managed
# monitoring key can be issued without handing out key management; the root key
# passes it too, which is what the studio's proxy sends. In open mode (no
# TTS_API_KEY) every caller holds it — local dev is unchanged.
OBSERVABILITY_SCOPE = "tts"


def _peer_is_loopback(request: Request) -> bool:
    client = request.client
    return bool(client) and client.host in ("127.0.0.1", "::1", "localhost")


def _require_metrics_access(
    request: Request,
    xi_api_key: str | None = Header(default=None, alias="xi-api-key"),
    authorization: str | None = Header(default=None),
) -> None:
    """/metrics is an operator surface, not a public one.

    Deployment shape + live latency percentiles are exactly what an attacker
    wants for free, so a configured key is required — with ONE exemption: an
    unauthenticated caller on loopback, because the replica launcher aggregates
    each replica's /metrics from the supervisor process with a stdlib urlopen
    that has no credential to send (service/replicas.py). Turn the exemption
    off with TTS_METRICS_ALLOW_LOOPBACK=0 where a same-host reverse proxy makes
    every request look local.

    NOT async: the key check reads api_keys.json from disk.
    """
    if SETTINGS.metrics_allow_loopback and _peer_is_loopback(request):
        return
    authorize_headers(xi_api_key, authorization, OBSERVABILITY_SCOPE)


@app.get("/health")
async def health(detail: bool = Depends(optional_scope(OBSERVABILITY_SCOPE))):
    """Liveness for everyone; deployment detail for key holders.

    The unauthenticated answer is deliberately boring — status plus the worker
    census — because every orchestrator probe, the replica supervisor and the
    studio's poller depend on reaching it without a credential
    (deploy/helm .../deployment.yaml readinessProbe, deploy/bootstrap.sh,
    benchmark_arm*.sh, service/loadtest.py, web/lib/useHealthPoll.ts). What
    used to ride along with it — `config` (workers, torch threads, language,
    quantize, the Arm `tuning` dict) and the full latency percentiles — is the
    service's own private surface and now requires the observability scope.
    The studio still sees it: its server-side proxy attaches the root key
    (web/lib/backend.ts), and `config`/`metrics` were already optional in the
    `Health` type it parses.
    """
    if ENGINE is None:
        return JSONResponse(status_code=503, content={"status": "loading"})
    if not ENGINE.ready:
        # `ready` is derived from LIVE worker threads, not from a one-time
        # startup flag: a replica whose worker died mid-loop reports not-ready
        # here (status "unavailable" once it has given up restarting it), which
        # is what lets the process supervisor replace it. Without this, a
        # replica with no functioning worker answered 200 forever while every
        # request piled into a queue nobody served.
        failed = bool(getattr(ENGINE, "failed", False))
        body = {"status": "unavailable" if failed else "loading"}
        live = getattr(ENGINE, "live_workers", None)
        if live is not None:
            body["workers_live"] = live
            body["workers_configured"] = getattr(ENGINE, "worker_count", live)
        return JSONResponse(status_code=503, content=body)
    if ENGINE.draining:
        # Readiness must fail the moment the drain starts, or the load balancer
        # keeps routing new work to a pod that answers every submit with 503.
        # Liveness is a TCP probe, so failing here removes us from the
        # Endpoints list without getting killed mid-drain.
        return JSONResponse(status_code=503, content={"status": "draining"})
    body = {"status": "ready"}
    if detail:
        body["config"] = ENGINE.config()
        body["metrics"] = ENGINE.metrics.snapshot()
    live = getattr(ENGINE, "live_workers", None)
    if live is not None:  # real engine; fakes in tests don't model threads
        body["workers_live"] = live
        body["workers_configured"] = getattr(ENGINE, "worker_count", live)
    return body


@app.get("/metrics", dependencies=[Depends(_require_metrics_access)])
async def metrics():
    if ENGINE is None:
        raise HTTPException(status_code=503, detail="engine not ready")
    # `cache` is this PROCESS's synthesis cache (per replica, never global).
    return {"config": ENGINE.config(), "metrics": ENGINE.metrics.snapshot(),
            "cache": SYNTH_CACHE.stats()}


def main():
    import uvicorn
    # uvicorn configures its OWN loggers and leaves the root logger at WARNING,
    # so everything this service says about itself at INFO — "engine ready",
    # each conversation's turns and latencies, the ingest phases — was written
    # and then discarded. Set the level on the `gravitone` tree here (and only
    # here, in the server entrypoint) so importing the app as a library or under
    # test still inherits the caller's logging policy.
    gravitone = logging.getLogger("gravitone")
    gravitone.setLevel(SETTINGS.log_level.upper())
    if not gravitone.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(levelname)s:%(name)s: %(message)s"))
        gravitone.addHandler(handler)
        # Our own handler AND propagation to a root handler prints every line
        # twice. Stopping here is safe precisely because we only reach this
        # branch when nothing else has claimed this logger — an operator who
        # configures `gravitone` themselves keeps their setup untouched.
        gravitone.propagate = False
    uvicorn.run(app, host=SETTINGS.host, port=SETTINGS.port, log_level="info")


if __name__ == "__main__":
    # `python -m service.app` executes this file as the module `__main__`, so
    # the served app — and the ENGINE the lifespan builds into it — live under
    # that name. Anything that later says `import service.app` (the gym's
    # in-process replay driver does) would then get a SECOND copy of this
    # module: a different app object whose ENGINE is None. That is how a replay
    # on a live box came to refuse with "the synthesis engine is not running"
    # while the same box was speaking fine. Alias the canonical name to THIS
    # instance before anything can import it, so there is only ever one.
    import sys

    sys.modules.setdefault("service.app", sys.modules[__name__])
    main()
