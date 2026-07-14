"""Shared takes + review sets — persisted renders behind public pages.

A take in the studio lives only in React state as a blob URL; sharing needs
it server-side. A shared take = one wav + one metadata JSON (character, the
metatagged text, the per-segment emotion report, timing) under
`<data>/takes/`. The web app serves them at /t/{id} as branded Voice Cards
with an emotion-synced player; each share is a landing page demonstrating
the emotion-metatag differentiator.

A REVIEW SET bundles 2-6 takes of the same script for client approval: the
creator sends one link, the client picks the winner on a no-login page, and
the pick is recorded. Voiceover work is approval-driven — this is the loop
agencies currently run over emailed WAV attachments. Accumulated picks also
answer "what should the studio default to" (see preferred()).

Bounded store: oldest takes/reviews are evicted past their caps — shares are
a marketing surface, not an archive.
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from service.config import SETTINGS

router = APIRouter(prefix="/v1/takes", tags=["takes"])
reviews_router = APIRouter(prefix="/v1/reviews", tags=["reviews"])

TAKES_DIR = Path(SETTINGS.voices_dir).parent / "takes"
REVIEWS_DIR = Path(SETTINGS.voices_dir).parent / "reviews"
MAX_TAKES = 500
MAX_REVIEWS = 200
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


# ── review sets (client approval loop) ────────────────────────────────────────
class ReviewReq(BaseModel):
    title: str = Field("", max_length=140)
    take_ids: list[str] = Field(..., min_length=2, max_length=6)


class PickReq(BaseModel):
    take_id: str
    reviewer: str = Field("", max_length=80)
    note: str = Field("", max_length=500)


def _review_path(review_id: str) -> Path:
    return REVIEWS_DIR / f"{review_id}.json"


def _load_review(review_id: str) -> dict:
    p = _review_path(review_id)
    if not review_id.isalnum() or not p.is_file():
        raise HTTPException(404, "review not found (links are evicted oldest-first)")
    return json.loads(p.read_text("utf-8"))


@reviews_router.post("", status_code=201)
def create_review(req: ReviewReq) -> dict:
    """Bundle takes of the same script into one shareable approval link."""
    takes: list[dict] = []
    for tid in req.take_ids:
        p = TAKES_DIR / f"{tid}.json"
        if not tid.isalnum() or not p.is_file():
            raise HTTPException(404, f"take '{tid}' not found — share it first")
        takes.append(json.loads(p.read_text("utf-8")))

    review_id = uuid.uuid4().hex[:10]
    record = {
        "id": review_id,
        "title": req.title.strip() or "Pick a take",
        # the script is shared across takes by construction; keep the first
        "script": takes[0].get("text", ""),
        "take_ids": [t["id"] for t in takes],
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pick": None,  # {take_id, reviewer, note, picked_at}
    }
    REVIEWS_DIR.mkdir(parents=True, exist_ok=True)
    metas = sorted(REVIEWS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime)
    for old in metas[: max(0, len(metas) - MAX_REVIEWS + 1)]:
        old.unlink(missing_ok=True)
        old.with_suffix(".pick").unlink(missing_ok=True)  # drop its decision sentinel
    _review_path(review_id).write_text(json.dumps(record), "utf-8")
    return {"review_id": review_id}


@reviews_router.get("/preferred")
def preferred() -> dict:
    """What clients actually pick — the studio's default voice recommendation.
    Most-picked character wins; ties break toward the most recent pick."""
    counts: dict[str, int] = {}
    latest: dict | None = None
    if REVIEWS_DIR.is_dir():
        for p in sorted(REVIEWS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime):
            try:
                r = json.loads(p.read_text("utf-8"))
            except json.JSONDecodeError:
                continue
            pick = r.get("pick")
            if not pick:
                continue
            cid = pick.get("character_id")
            if cid:
                counts[cid] = counts.get(cid, 0) + 1
                latest = pick
    if not counts:
        return {"character_id": None, "picks": 0, "counts": {}}
    top = max(counts, key=lambda c: (counts[c], c == (latest or {}).get("character_id")))
    return {"character_id": top, "picks": counts[top], "counts": counts,
            "latest": latest}


@reviews_router.get("/{review_id}")
def get_review(review_id: str) -> dict:
    review = _load_review(review_id)
    takes = []
    for tid in review["take_ids"]:
        p = TAKES_DIR / f"{tid}.json"
        if p.is_file():  # a take may have been evicted from the bounded store
            takes.append(json.loads(p.read_text("utf-8")))
    return {**review, "takes": takes}


@reviews_router.post("/{review_id}/pick")
def pick_take(review_id: str, req: PickReq) -> dict:
    """The client's decision. First pick wins — a decided review is final
    (re-opening an approval is a new link, not an edit)."""
    review = _load_review(review_id)
    if review.get("pick"):
        raise HTTPException(409, "this review has already been decided")
    if req.take_id not in review["take_ids"]:
        raise HTTPException(400, "that take is not part of this review")

    take_meta = TAKES_DIR / f"{req.take_id}.json"
    character_id = ""
    if take_meta.is_file():
        character_id = json.loads(take_meta.read_text("utf-8")).get("character_id", "")

    pick = {
        "take_id": req.take_id,
        "character_id": character_id,
        "reviewer": req.reviewer.strip()[:80],
        "note": req.note.strip()[:500],
        "picked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    # First pick wins ATOMICALLY across threads AND replica processes: the read
    # check above is only a fast reject, and two near-simultaneous picks would
    # both pass it and the second write would clobber the first. The winner is
    # whoever creates the .pick sentinel with O_CREAT|O_EXCL (an atomic
    # create-if-absent); everyone else gets a clean 409.
    lock = REVIEWS_DIR / f"{review_id}.pick"
    try:
        os.close(os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
    except FileExistsError:
        raise HTTPException(409, "this review has already been decided")
    try:
        review["pick"] = pick
        _review_path(review_id).write_text(json.dumps(review), "utf-8")
    except Exception:
        lock.unlink(missing_ok=True)  # let a transient write failure be retried
        raise
    return pick
