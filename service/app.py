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
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

import base64
import json

from service.auth import require_read_write, require_scope
from service.config import SETTINGS
from service.demand import record_fallback
from service.emotions import parse_segments, resolve
from service.engine import AdmissionRejected, TtsEngine, concat_wavs, wav_bytes_to_mp3
from service.voices import emotion_map, router as voices_router
from service.keys import router as keys_router
from service.ingest_api import router as ingest_router

ENGINE: TtsEngine | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global ENGINE
    ENGINE = TtsEngine()
    # Model loading is blocking; do it off the event loop.
    await asyncio.get_event_loop().run_in_executor(None, ENGINE.start)
    yield
    ENGINE.stop()


app = FastAPI(title="Pocket TTS Service", version="1.0.0", lifespan=lifespan)


class VoiceSettings(BaseModel):
    """Expression controls.

    Pocket TTS has no emotion/style/speed parameter — expression lives in the
    reference audio. What IS tunable are the sampling knobs below, which the
    engine applies to the worker's model instance per request.
    """
    # 0.5 (consistent) .. 1.0 (expressive). Model default 0.7.
    temperature: float | None = None
    # 0 (off) .. 1 (tight). Mapped to the model's `noise_clamp`.
    stability: float | None = None
    # 1 (fast) .. 5 (best). Mapped to `lsd_decode_steps`; costs realtime factor.
    quality: int | None = None
    # accepted for ElevenLabs compatibility; not honoured by pocket-tts
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


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=8000)
    model_id: str | None = "pocket_tts"
    voice_settings: VoiceSettings | None = None
    frames_after_eos: int | None = None


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
    loop = asyncio.get_event_loop()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(None, job.future.result),
            timeout=SETTINGS.request_timeout_s,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="synthesis timed out")
    except Exception as exc:  # noqa: BLE001 - worker error -> 500
        raise HTTPException(status_code=500, detail=f"synthesis failed: {exc}")


class _Backpressure(Exception):
    """Queue full — translated to the 429 + Retry-After response."""


def _backpressure_response(exc: _Backpressure) -> JSONResponse:
    assert ENGINE is not None
    return JSONResponse(status_code=429,
                        content={"detail": str(exc), "queue": ENGINE.metrics.snapshot()},
                        headers={"Retry-After": "1"})


def _resolve_emotion_address(voice_id: str, emotion: str | None) -> tuple[str, dict[str, str]]:
    """Emotion-addressable voices — the Gravitone extension to the
    ElevenLabs-compatible endpoint.

    A caller may address `{character_id}:{emotion}` in the path (e.g.
    `sarah:excited`) or pass `?emotion=` with a character id. Emotions the
    Character lacks fall back to baseline, reported in response headers.
    Plain voice_ids pass through untouched.
    """
    if not emotion and ":" not in voice_id:
        return voice_id, {}
    character_id, _, path_emotion = voice_id.partition(":")
    requested = (emotion or path_emotion).strip().lower()
    emap = emotion_map(character_id)
    if not emap:
        raise HTTPException(status_code=404, detail=f"unknown character '{character_id}'")
    resolved_id, used, fell_back = resolve(requested, emap)
    if fell_back:
        record_fallback(character_id, requested)
    return resolved_id, {
        "X-Character": character_id,
        "X-Emotion-Requested": requested,
        "X-Emotion-Used": used,
        "X-Emotion-Fallback": "true" if fell_back else "false",
    }


def _parse_format(output_format: str) -> tuple[str, str]:
    """Return (kind, content_type). kind in {wav, mp3, pcm}."""
    fmt = (output_format or "wav").lower()
    if fmt.startswith("mp3"):
        return "mp3", "audio/mpeg"
    if fmt.startswith("pcm"):
        return "pcm", "audio/basic"
    return "wav", "audio/wav"


@app.post("/v1/text-to-speech/{voice_id}", dependencies=[Depends(require_scope("tts"))])
async def text_to_speech(
    voice_id: str,
    req: TTSRequest,
    output_format: str = Query("wav_24000"),
    emotion: str | None = Query(None, description="Gravitone extension: address a Character's emotion voice (or use {character_id}:{emotion} as the path voice_id)"),
):
    assert ENGINE is not None
    kind, content_type = _parse_format(output_format)
    voice_id, emotion_headers = _resolve_emotion_address(voice_id, emotion)

    try:
        result = await _submit_and_wait(voice_id, req.text, _overrides(req.voice_settings),
                                        frames_after_eos=req.frames_after_eos)
    except _Backpressure as exc:
        # Backpressure: tell the client to retry — the queue cap was hit.
        return _backpressure_response(exc)

    loop = asyncio.get_event_loop()
    if kind == "mp3":
        body = await loop.run_in_executor(None, wav_bytes_to_mp3, result.wav_bytes)
    elif kind == "pcm":
        # strip the 44-byte WAV header -> raw PCM16
        body = result.wav_bytes[44:]
    else:
        body = result.wav_bytes

    return Response(
        content=body, media_type=content_type,
        headers={
            "X-Audio-Seconds": str(result.audio_seconds),
            "X-Synth-Seconds": str(result.synth_seconds),
            "X-Queue-Seconds": str(result.queue_seconds),
            "X-Realtime-Factor": str(round(result.audio_seconds / result.synth_seconds, 3))
            if result.synth_seconds else "n/a",
            **emotion_headers,
        },
    )


# Voice + Character management lives in service/voices.py. Read endpoints
# (list voices/characters/emotions) accept a tts-scoped key so ElevenLabs
# drop-in clients work; mutations need the "voices" scope.
app.include_router(voices_router, dependencies=[Depends(require_read_write("tts", "voices"))])
# API key management (issue / rotate / revoke) — root TTS_API_KEY only.
app.include_router(keys_router, dependencies=[Depends(require_scope("admin"))])
# Character ingestion (scan a recording → review → commit) — "clone" scope.
app.include_router(ingest_router, dependencies=[Depends(require_scope("clone"))])


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

    wavs: list[bytes] = []
    report: list[dict] = []
    total_audio = 0.0
    total_synth = 0.0

    for seg in segments:
        voice_id, used, fell_back = resolve(seg.emotion, emap)
        if fell_back:
            record_fallback(req.character_id, seg.emotion)
        try:
            result = await _submit_and_wait(voice_id, seg.text, overrides)
        except _Backpressure as exc:
            return _backpressure_response(exc)

        wavs.append(result.wav_bytes)
        total_audio += result.audio_seconds
        total_synth += result.synth_seconds
        report.append({
            "text": seg.text, "requested": seg.emotion, "used": used,
            "fallback": fell_back, "voice_id": voice_id, "seconds": result.audio_seconds,
        })

    body = concat_wavs(wavs)
    rtf = round(total_audio / total_synth, 3) if total_synth else 0.0
    return Response(
        content=body, media_type="audio/wav",
        headers={
            "X-Audio-Seconds": str(round(total_audio, 2)),
            "X-Synth-Seconds": str(round(total_synth, 3)),
            "X-Realtime-Factor": str(rtf),
            "X-Segments": base64.b64encode(json.dumps(report).encode()).decode(),
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

    # Fail fast: validate every character before synthesizing anything.
    emaps: dict[str, dict[str, str]] = {}
    for i, line in enumerate(req.lines):
        if line.character_id not in emaps:
            emap = emotion_map(line.character_id)
            if not emap:
                raise HTTPException(status_code=404,
                                    detail=f"unknown character '{line.character_id}' (line {i})")
            emaps[line.character_id] = emap

    wavs: list[bytes] = []
    report: list[dict] = []
    total_audio = 0.0
    total_synth = 0.0

    for i, line in enumerate(req.lines):
        emap = emaps[line.character_id]
        overrides = _overrides(line.voice_settings)
        for seg in parse_segments(line.text):
            voice_id, used, fell_back = resolve(seg.emotion, emap)
            if fell_back:
                record_fallback(line.character_id, seg.emotion)
            try:
                result = await _submit_and_wait(voice_id, seg.text, overrides)
            except _Backpressure as exc:
                return _backpressure_response(exc)
            wavs.append(result.wav_bytes)
            total_audio += result.audio_seconds
            total_synth += result.synth_seconds
            report.append({
                "line": i, "character_id": line.character_id, "text": seg.text,
                "requested": seg.emotion, "used": used, "fallback": fell_back,
                "voice_id": voice_id, "seconds": result.audio_seconds,
            })

    body = concat_wavs(wavs)
    rtf = round(total_audio / total_synth, 3) if total_synth else 0.0
    return Response(
        content=body, media_type="audio/wav",
        headers={
            "X-Audio-Seconds": str(round(total_audio, 2)),
            "X-Synth-Seconds": str(round(total_synth, 3)),
            "X-Realtime-Factor": str(rtf),
            "X-Performance-Report": base64.b64encode(json.dumps(report).encode()).decode(),
        },
    )


@app.get("/health")
async def health():
    if ENGINE is None or not ENGINE.ready:
        return JSONResponse(status_code=503, content={"status": "loading"})
    return {"status": "ready", "config": ENGINE.config(), "metrics": ENGINE.metrics.snapshot()}


@app.get("/metrics")
async def metrics():
    if ENGINE is None:
        raise HTTPException(status_code=503, detail="engine not ready")
    return {"config": ENGINE.config(), "metrics": ENGINE.metrics.snapshot()}


def main():
    import uvicorn
    uvicorn.run(app, host=SETTINGS.host, port=SETTINGS.port, log_level="info")


if __name__ == "__main__":
    main()
