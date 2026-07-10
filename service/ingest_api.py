"""HTTP surface for the Character-ingestion flow (with speaker selection).

  POST /v1/ingest/scan                      (file) → { job_id }  [analyze: transcribe+isolate]
  GET  /v1/ingest/{job}                     → { status, step, steps[], partial, speakers, result }
  GET  /v1/ingest/{job}/speaker-preview/{id}→ per-speaker sample wav
  POST /v1/ingest/{job}/speaker             { speaker_id }  [start label+stem for that speaker]
  GET  /v1/ingest/{job}/preview/{emotion}   → stem wav
  POST /v1/ingest/{job}/commit              { character, emotions[], character_id? } → voices

Status flow: running → awaiting_speaker → running → done. `partial` streams live
intermediate data (word count, speakers, per-emotion tally) for a data-rich loader.
"""
from __future__ import annotations

import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from service import ingest

router = APIRouter(prefix="/v1/ingest", tags=["ingest"])

STEPS = [
    {"key": "transcribe", "label": "Transcribe & diarize"},
    {"key": "isolate", "label": "Isolate voice"},
    {"key": "label", "label": "Detect emotions"},
    {"key": "stem", "label": "Build emotion stems"},
]

JOBS: dict[str, dict] = {}
_TTL = 60 * 30


def _gc() -> None:
    now = time.time()
    for jid in [j for j, v in JOBS.items() if now - v["created"] > _TTL]:
        shutil.rmtree(JOBS[jid]["work_dir"], ignore_errors=True)
        JOBS.pop(jid, None)


def _mk_step(job: dict, key: str, state: str) -> None:
    for s in job["steps"]:
        if s["key"] == key:
            s["state"] = state
    job["step"] = key


def _analyze(job_id: str, audio: Path) -> None:
    job = JOBS[job_id]
    try:
        res = ingest.analyze(
            audio, Path(job["work_dir"]),
            progress=lambda k, s: _mk_step(job, k, s),
            partial=lambda d: job["partial"].update(d))
        job["speakers"] = res["speakers"]
        job["duration"] = res["duration"]
        job["status"] = "awaiting_speaker"
    except Exception as exc:  # noqa: BLE001
        job["status"] = "error"; job["error"] = str(exc)[:400]
    finally:
        audio.unlink(missing_ok=True)


def _label(job_id: str, target: str) -> None:
    job = JOBS[job_id]
    try:
        res = ingest.label_and_stem(
            Path(job["work_dir"]), target,
            progress=lambda k, s: _mk_step(job, k, s),
            partial=lambda d: job["partial"].update(d))
        job["result"] = {"duration": job.get("duration", 0),
                         "speakers": [s["id"] for s in job.get("speakers", [])], **res}
        job["status"] = "done"
    except Exception as exc:  # noqa: BLE001
        job["status"] = "error"; job["error"] = str(exc)[:400]


@router.post("/scan")
async def start_scan(file: UploadFile = File(...)) -> dict:
    _gc()
    job_id = uuid.uuid4().hex[:12]
    work_dir = Path(tempfile.mkdtemp(prefix=f"gvt-ingest-{job_id}-"))
    src = work_dir / f"src-{file.filename or 'upload'}"
    src.write_bytes(await file.read())
    JOBS[job_id] = {
        "id": job_id, "status": "running", "step": None,
        "steps": [{**s, "state": "pending"} for s in STEPS],
        "partial": {}, "speakers": None, "duration": 0, "result": None, "error": None,
        "work_dir": str(work_dir), "created": time.time()}
    threading.Thread(target=_analyze, args=(job_id, src), daemon=True).start()
    return {"job_id": job_id}


@router.get("/{job_id}")
def get_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "job not found or expired")
    return {k: job[k] for k in ("id", "status", "step", "steps", "partial",
                                "speakers", "duration", "result", "error")}


@router.get("/{job_id}/speaker-preview/{sid}")
def speaker_preview(job_id: str, sid: str) -> FileResponse:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    p = Path(job["work_dir"]) / f"speaker_{sid}.wav"
    if not p.is_file():
        raise HTTPException(404, "preview not found")
    return FileResponse(str(p), media_type="audio/wav")


class SpeakerReq(BaseModel):
    speaker_id: str


@router.post("/{job_id}/speaker")
def choose_speaker(job_id: str, req: SpeakerReq) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "job not found or expired")
    if job["status"] != "awaiting_speaker":
        raise HTTPException(409, "not awaiting speaker")
    job["status"] = "running"
    job["partial"] = {}
    threading.Thread(target=_label, args=(job_id, req.speaker_id), daemon=True).start()
    return {"status": "running"}


@router.get("/{job_id}/preview/{emotion}")
def preview(job_id: str, emotion: str) -> FileResponse:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    stem = Path(job["work_dir"]) / f"stem_{emotion}.wav"
    if not stem.is_file():
        raise HTTPException(404, "stem not found")
    return FileResponse(str(stem), media_type="audio/wav")


class CommitReq(BaseModel):
    character: str
    emotions: list[str]
    character_id: str | None = None


@router.post("/{job_id}/commit")
def commit(job_id: str, req: CommitReq) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "job not found or expired")
    if job["status"] != "done":
        raise HTTPException(409, "scan not finished")
    if not req.character.strip() and not req.character_id:
        raise HTTPException(400, "character name required")
    try:
        created = ingest.commit(Path(job["work_dir"]), req.character.strip(),
                                req.emotions, req.character_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"commit failed: {exc}")
    return {"created": created}
