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
Auth: optional `xi-api-key` header, enabled by setting TTS_API_KEY.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from service.config import SETTINGS
from service.engine import AdmissionRejected, TtsEngine, wav_bytes_to_mp3

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
    temperature: float | None = None
    # accepted for ElevenLabs compatibility; not all map to pocket-tts
    stability: float | None = None
    similarity_boost: float | None = None
    style: float | None = None


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=8000)
    model_id: str | None = "pocket_tts"
    voice_settings: VoiceSettings | None = None
    frames_after_eos: int | None = None


def _check_auth(xi_api_key: str | None):
    if SETTINGS.api_key and xi_api_key != SETTINGS.api_key:
        raise HTTPException(status_code=401, detail="invalid or missing xi-api-key")


def _parse_format(output_format: str) -> tuple[str, str]:
    """Return (kind, content_type). kind in {wav, mp3, pcm}."""
    fmt = (output_format or "wav").lower()
    if fmt.startswith("mp3"):
        return "mp3", "audio/mpeg"
    if fmt.startswith("pcm"):
        return "pcm", "audio/basic"
    return "wav", "audio/wav"


@app.post("/v1/text-to-speech/{voice_id}")
async def text_to_speech(
    voice_id: str,
    req: TTSRequest,
    output_format: str = Query("wav_24000"),
    xi_api_key: str | None = Header(default=None, alias="xi-api-key"),
):
    _check_auth(xi_api_key)
    assert ENGINE is not None
    kind, content_type = _parse_format(output_format)
    temp = req.voice_settings.temperature if req.voice_settings else None

    try:
        job = ENGINE.submit(
            voice_id=voice_id, text=req.text, temperature=temp,
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


@app.get("/v1/voices")
async def list_voices():
    vd = Path(SETTINGS.voices_dir)
    exported = sorted(p.stem for p in vd.glob("*.safetensors")) if vd.is_dir() else []
    builtins = [
        "alba", "anna", "vera", "charles", "paul", "george", "mary", "jane",
        "michael", "eve", "cosette", "marius", "javert", "jean", "fantine",
        "eponine", "azelma", "bill_boerst", "peter_yearsley", "stuart_bell",
        "caro_davy", "giovanni", "lola", "juergen", "rafael", "estelle",
    ]
    return {
        "voices": [{"voice_id": v, "name": v, "category": "cloned"} for v in exported]
        + [{"voice_id": v, "name": v, "category": "premade"} for v in builtins]
    }


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
