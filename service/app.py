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
):
    assert ENGINE is not None
    kind, content_type = _parse_format(output_format)

    try:
        job = ENGINE.submit(
            voice_id=voice_id, text=req.text, overrides=_overrides(req.voice_settings),
            frames_after_eos=req.frames_after_eos,
        )
    except AdmissionRejected as exc:
        # Backpressure: tell the client to retry — the queue cap was hit.
        return JSONResponse(
            status_code=429,
            content={"detail": str(exc), "queue": ENGINE.metrics.snapshot()},
            headers={"Retry-After": "1"},
        )

    loop = asyncio.get_event_loop()
    try:
        result = await asyncio.wait_for(
            loop.run_in_executor(None, job.future.result),
            timeout=SETTINGS.request_timeout_s,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="synthesis timed out")
    except Exception as exc:  # noqa: BLE001 - worker error -> 500
        raise HTTPException(status_code=500, detail=f"synthesis failed: {exc}")

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
    loop = asyncio.get_event_loop()

    wavs: list[bytes] = []
    report: list[dict] = []
    total_audio = 0.0
    total_synth = 0.0

    for seg in segments:
        voice_id, used, fell_back = resolve(seg.emotion, emap)
        try:
            job = ENGINE.submit(voice_id=voice_id, text=seg.text, overrides=overrides)
        except AdmissionRejected as exc:
            return JSONResponse(status_code=429, content={"detail": str(exc)},
                                headers={"Retry-After": "1"})
        try:
            result = await asyncio.wait_for(
                loop.run_in_executor(None, job.future.result),
                timeout=SETTINGS.request_timeout_s,
            )
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail="synthesis timed out")
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"synthesis failed: {exc}")

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
