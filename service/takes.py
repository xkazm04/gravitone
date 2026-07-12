"""Shared takes — persisted playground renders behind public share pages.

A take in the studio lives only in React state as a blob URL; sharing needs
it server-side. A shared take = one wav + one metadata JSON (character, the
metatagged text, the per-segment emotion report, timing) under
`<data>/takes/`. The web app serves them at /t/{id} as branded Voice Cards
with an emotion-synced player; each share is a landing page demonstrating
the emotion-metatag differentiator.

Bounded store: oldest takes are evicted past MAX_TAKES — shares are a
marketing surface, not an archive.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from service.config import SETTINGS

router = APIRouter(prefix="/v1/takes", tags=["takes"])

TAKES_DIR = Path(SETTINGS.voices_dir).parent / "takes"
MAX_TAKES = 500
MAX_AUDIO_BYTES = 25 * 1024 * 1024  # ~4 min of 24 kHz wav
MAX_TEXT = 8000
MAX_SEGMENTS = 200


def _evict_oldest() -> None:
    metas = sorted(TAKES_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime)
    for p in metas[: max(0, len(metas) - MAX_TAKES + 1)]:
        p.with_suffix(".wav").unlink(missing_ok=True)
        p.unlink(missing_ok=True)


@router.post("", status_code=201)
async def create_take(
    file: UploadFile = File(...),
    meta: str = Form(...),
) -> dict:
    """Persist one rendered take (wav + metadata) and mint its share id."""
    try:
        m = json.loads(meta)
    except json.JSONDecodeError:
        raise HTTPException(400, "meta must be JSON")

    text = str(m.get("text", ""))[:MAX_TEXT]
    segments = m.get("segments") or []
    if not text or not isinstance(segments, list) or len(segments) > MAX_SEGMENTS:
        raise HTTPException(400, "meta needs text and a segments list")

    audio = await file.read()
    if not audio or len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(400, f"audio must be 1 byte to {MAX_AUDIO_BYTES // 2**20} MB")
    if audio[:4] != b"RIFF":
        raise HTTPException(400, "audio must be a wav file")

    take_id = uuid.uuid4().hex[:10]
    record = {
        "id": take_id,
        "character_id": str(m.get("character_id", ""))[:100],
        "character_name": str(m.get("character_name", "Character"))[:100],
        "text": text,
        "seconds": float(m.get("seconds", 0) or 0),
        "rtf": float(m.get("rtf", 0) or 0),
        "segments": [
            {
                "text": str(s.get("text", ""))[:300],
                "requested": str(s.get("requested", "baseline"))[:32],
                "used": str(s.get("used", "baseline"))[:32],
                "fallback": bool(s.get("fallback", False)),
                "seconds": float(s.get("seconds", 0) or 0),
            }
            for s in segments
        ],
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    TAKES_DIR.mkdir(parents=True, exist_ok=True)
    _evict_oldest()
    (TAKES_DIR / f"{take_id}.wav").write_bytes(audio)
    (TAKES_DIR / f"{take_id}.json").write_text(json.dumps(record), "utf-8")
    return {"take_id": take_id}


@router.get("/{take_id}")
def get_take(take_id: str) -> dict:
    p = TAKES_DIR / f"{take_id}.json"
    if not take_id.isalnum() or not p.is_file():
        raise HTTPException(404, "take not found (shares are evicted oldest-first)")
    return json.loads(p.read_text("utf-8"))


@router.get("/{take_id}/audio")
def get_take_audio(take_id: str) -> FileResponse:
    p = TAKES_DIR / f"{take_id}.wav"
    if not take_id.isalnum() or not p.is_file():
        raise HTTPException(404, "take audio not found")
    return FileResponse(str(p), media_type="audio/wav")
